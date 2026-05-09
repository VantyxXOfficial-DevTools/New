/**
 * qrispw-webhook.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoint:
 *   GET  /api/qrispw-webhook  → health check
 *   POST /api/qrispw-webhook  → terima callback dari qris.pw
 *
 * Alur otomatis (tanpa perlu domain/URL server bot):
 *   1. QRIS.PW kirim POST ke sini saat pembayaran berhasil
 *   2. Verifikasi signature HMAC-SHA256
 *   3. Parse order_id → userId + packageId
 *   4. Kirim pesan aktivasi VXOACT ke OWNER_ID via Telegram Bot API
 *      → bot baca pesan itu → aktifkan premium otomatis → hapus pesan
 *   5. Kirim notifikasi biasa ke owner + channel
 *
 * Environment Variables (set di Vercel dashboard):
 *   QRISPW_WEBHOOK_SECRET  — webhook secret dari dashboard qris.pw
 *   BOT_TOKEN              — token bot Telegram
 *   OWNER_ID               — Telegram user ID owner (penerima pesan VXOACT)
 *   CHANNEL_ID             — Telegram channel/group ID (notifikasi publik)
 *   BOT_ACTIVATION_SECRET  — secret untuk HMAC pesan VXOACT (sama dengan di .env bot)
 *
 * Format order_id:
 *   VXOPAY-{userId}-{type}_{period}_{qty}-{timestamp}
 *   Contoh: VXOPAY-123456789-super_daily_3-1746780000000
 */

import crypto from 'crypto';

export default async function handler(req, res) {

    // ── GET: Health check ──────────────────────────────────────────────────────
    if (req.method === 'GET') {
        return res.status(200).json({
            status:    'online',
            service:   'VXO Payment Webhook (QRIS.PW)',
            endpoint:  '/api/qrispw-webhook',
            timestamp: new Date().toISOString(),
        });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── Baca raw body ──────────────────────────────────────────────────────────
    let rawBody;
    try { rawBody = await readRawBody(req); }
    catch { return res.status(400).json({ error: 'Failed to read request body' }); }

    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

    // ── Verifikasi HMAC SHA256 signature dari qris.pw ─────────────────────────
    const webhookSecret = process.env.QRISPW_WEBHOOK_SECRET || '';
    if (webhookSecret) {
        if (!verifyQrisSignature(payload, webhookSecret)) {
            return res.status(401).json({ error: 'Invalid signature' });
        }
    }

    const { transaction_id, order_id, amount, status, paid_at, payment_method } = payload;

    // Hanya proses pembayaran yang berhasil
    if (status !== 'paid') {
        return res.status(200).json({
            received: true, status,
            message:  `Status "${status}" diabaikan, bukan "paid"`,
        });
    }

    if (!order_id) {
        return res.status(400).json({ error: 'order_id tidak ada dalam payload' });
    }

    // ── Parse order_id → userId & packageId ───────────────────────────────────
    const parsed = parseOrderId(order_id);
    if (!parsed) {
        return res.status(400).json({
            error:    'Format order_id tidak valid',
            received: order_id,
            expected: 'VXOPAY-{userId}-{type}_{period}_{qty}-{timestamp}',
        });
    }

    const { userId, packageId } = parsed;
    const amountNum     = Number(amount || 0);
    const amountFmt     = formatRupiah(amountNum);
    const paidTime      = paid_at ? formatDateTime(paid_at) : formatDateTime(new Date().toISOString());
    const txnId         = transaction_id || order_id;

    const botToken          = process.env.BOT_TOKEN           || '';
    const ownerId           = process.env.OWNER_ID            || '';
    const channelId         = process.env.CHANNEL_ID          || '';
    const activationSecret  = process.env.BOT_ACTIVATION_SECRET || '';

    if (!botToken || !ownerId) {
        console.error('[webhook] BOT_TOKEN atau OWNER_ID tidak diset');
        return res.status(500).json({ error: 'BOT_TOKEN atau OWNER_ID tidak dikonfigurasi' });
    }

    // ── Kirim pesan aktivasi VXOACT ke OWNER_ID ───────────────────────────────
    // Bot akan membaca pesan ini, verifikasi HMAC, aktifkan premium, lalu hapus pesan
    let activationSent = false;
    try {
        // Hitung HMAC untuk verifikasi di sisi bot
        const hmac = activationSecret
            ? crypto.createHmac('sha256', activationSecret)
                .update(`${userId}|${packageId}|${txnId}`)
                .digest('hex')
            : 'no-secret';

        const activationMsg = `VXOACT|${userId}|${packageId}|${amountNum}|${txnId}|${hmac}`;

        await tgSend(botToken, ownerId, activationMsg, false);
        activationSent = true;
        console.log(`[webhook] ✅ Pesan aktivasi terkirim ke owner: userId=${userId} packageId=${packageId}`);
    } catch (e) {
        console.error('[webhook] ❌ Gagal kirim pesan aktivasi:', e.message);
    }

    // ── Kirim notifikasi Telegram ke owner + channel ──────────────────────────
    const statusLine = activationSent
        ? `✅ Pesan aktivasi terkirim ke bot.`
        : `⚠️ Gagal kirim aktivasi — cek BOT_TOKEN / OWNER_ID.`;

    const ownerMsg = [
        `💳 <b>PAYMENT MASUK (QRIS.PW)</b>`,
        ``,
        `👤 User ID  : <code>${userId}</code>`,
        `📦 Paket   : <code>${packageId}</code>`,
        `💰 Nominal : <b>${amountFmt}</b>`,
        `🏧 Metode  : ${payment_method || 'QRIS'}`,
        `⏰ Waktu   : ${paidTime}`,
        ``,
        `🆔 Order   : <code>${order_id}</code>`,
        `🔖 Txn ID  : <code>${txnId}</code>`,
        ``,
        statusLine,
    ].join('\n');

    const channelMsg = [
        `✅ <b>Pembayaran Berhasil!</b>`,
        ``,
        `👤 User    : <code>${userId}</code>`,
        `📦 Paket  : <code>${packageId}</code>`,
        `💰 Nominal: <b>${amountFmt}</b>`,
        `⏰ Waktu  : ${paidTime}`,
    ].join('\n');

    const [ownerResult, channelResult] = await Promise.allSettled([
        tgSend(botToken, ownerId,   ownerMsg,   true),
        channelId ? tgSend(botToken, channelId, channelMsg, true) : Promise.resolve(null),
    ]);

    const ownerOk   = ownerResult.status   === 'fulfilled';
    const channelOk = channelResult.status === 'fulfilled' && channelResult.value !== null;

    return res.status(200).json({
        received:          true,
        status:            'processed',
        transaction_id:    txnId,
        order_id,
        userId,
        packageId,
        activation_sent:   activationSent,
        notifications:     { owner: ownerOk, channel: channelOk },
    });
}

// ─── Kirim pesan Telegram ──────────────────────────────────────────────────────

async function tgSend(token, chatId, text, parseHtml = true) {
    const body = { chat_id: chatId, text };
    if (parseHtml) body.parse_mode = 'HTML';

    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
    });
    if (!resp.ok) {
        const err = await resp.text().catch(() => '');
        throw new Error(`Telegram API ${resp.status}: ${err}`);
    }
    return resp.json();
}

// ─── Verifikasi HMAC SHA256 dari qris.pw ──────────────────────────────────────

function verifyQrisSignature(payload, secret) {
    try {
        const incoming = payload?.signature;
        if (!incoming) return false;
        const copy = { ...payload };
        delete copy.signature;
        const expected = crypto
            .createHmac('sha256', secret)
            .update(JSON.stringify(copy))
            .digest('hex');
        if (expected.length !== incoming.length) return false;
        return crypto.timingSafeEqual(
            Buffer.from(expected, 'hex'),
            Buffer.from(incoming, 'hex'),
        );
    } catch { return false; }
}

// ─── Parse order_id ───────────────────────────────────────────────────────────
// Format: VXOPAY-{userId}-{type}_{period}_{qty}-{timestamp}
// Contoh: VXOPAY-123456789-super_daily_3-1746780000000

function parseOrderId(orderId) {
    const match = String(orderId).match(/^VXOPAY-(\d+)-([A-Za-z0-9_]+)-(\d+)$/);
    if (!match) return null;
    return { userId: match[1], packageId: match[2], timestamp: match[3] };
}

// ─── Baca raw body ─────────────────────────────────────────────────────────────

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data',  chunk => chunks.push(chunk));
        req.on('end',   ()    => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatRupiah(amount) {
    return 'Rp' + Number(amount || 0).toLocaleString('id-ID');
}

function formatDateTime(iso) {
    try {
        return new Date(iso).toLocaleString('id-ID', {
            timeZone: 'Asia/Jakarta',
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }) + ' WIB';
    } catch { return iso; }
}
