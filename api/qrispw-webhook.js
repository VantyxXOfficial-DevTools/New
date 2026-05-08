import crypto from 'crypto';

export default async function handler(req, res) {
    if (req.method === 'GET') {
        return res.status(200).json({
            status: 'ok',
            service: 'VXO Bot — QRIS.PW Webhook',
            timestamp: new Date().toISOString(),
        });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    let rawBody;
    try {
        rawBody = await getRawBody(req);
    } catch {
        return res.status(400).json({ error: 'Cannot read body' });
    }

    let payload;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
    }

    // Verifikasi signature dari qris.pw
    const webhookSecret = process.env.QRISPW_WEBHOOK_SECRET || '';
    if (webhookSecret) {
        const isValid = verifyQrisSignature(payload, webhookSecret);
        if (!isValid) {
            console.warn('[webhook] Signature tidak valid, transaction_id:', payload?.transaction_id);
            return res.status(401).json({ error: 'Invalid signature' });
        }
    }

    const { transaction_id, order_id, amount, status, paid_at } = payload;
    console.log(`[webhook] Diterima: ${transaction_id} | status=${status} | amount=${amount}`);

    // Hanya proses status "paid"
    if (status !== 'paid') {
        return res.status(200).json({ received: true, status, message: 'Bukan status paid, diabaikan' });
    }

    if (!order_id) {
        return res.status(400).json({ error: 'order_id tidak ada' });
    }

    // Parse order_id → ambil userId dan packageId
    // Format: VXOPAY-{userId}-{packageId}-{timestamp}
    const parsed = parseOrderId(order_id);
    if (!parsed) {
        console.error('[webhook] Gagal parse order_id:', order_id);
        return res.status(400).json({ error: 'Format order_id tidak valid' });
    }

    const { userId, packageId } = parsed;
    console.log(`[webhook] Payment lunas: userId=${userId} | packageId=${packageId} | amount=${amount}`);

    // Kirim ke bot Pterodactyl (metode utama)
    const botCallbackUrl    = process.env.BOT_CALLBACK_URL    || '';
    const botCallbackSecret = process.env.BOT_CALLBACK_SECRET || '';
    let notified = false;

    if (botCallbackUrl) {
        try {
            const resp = await fetchWithTimeout(botCallbackUrl, {
                method: 'POST',
                headers: {
                    'Content-Type':     'application/json',
                    'Authorization':    `Bearer ${botCallbackSecret}`,
                    'X-Webhook-Source': 'qrispw-vercel',
                },
                body: JSON.stringify({ transactionId: transaction_id, orderId: order_id, userId, packageId, amount, paidAt: paid_at, gateway: 'qrispw' }),
            }, 10_000);

            notified = resp.ok;
            if (!resp.ok) console.error('[webhook] Bot callback gagal, status:', resp.status);
            else console.log('[webhook] Bot berhasil diberitahu');
        } catch (e) {
            console.error('[webhook] Bot callback error:', e.message);
        }
    }

    // Fallback: kirim notifikasi ke owner via Telegram jika bot tidak bisa dihubungi
    if (!notified) {
        const botToken = process.env.BOT_TOKEN || '';
        const ownerId  = process.env.OWNER_ID  || '';
        if (botToken && ownerId) {
            try {
                await sendTelegramMessage(botToken, ownerId, [
                    `🔔 <b>PAYMENT BERHASIL</b>`,
                    ``,
                    `💳 Gateway: QRIS.PW`,
                    `🆔 Transaction: <code>${transaction_id}</code>`,
                    `👤 User ID: <code>${userId}</code>`,
                    `📦 Package: <code>${packageId}</code>`,
                    `💰 Amount: Rp${Number(amount).toLocaleString('id-ID')}`,
                    `⏰ Paid at: ${paid_at || new Date().toISOString()}`,
                    ``,
                    `⚠️ <i>BOT_CALLBACK_URL gagal — aktifkan premium manual jika perlu.</i>`,
                ].join('\n'));
            } catch (e) {
                console.error('[webhook] Telegram fallback error:', e.message);
            }
        }
    }

    return res.status(200).json({ received: true, status: 'processed', transaction_id, userId, packageId, notified });
}

// ─── Helper functions ──────────────────────────────────────────────────────────

function parseOrderId(orderId) {
    const m = String(orderId || '').match(/^VXOPAY-(\d+)-(.+?)-\d+$/);
    if (!m) return null;
    return { userId: m[1], packageId: m[2] };
}

function verifyQrisSignature(payload, webhookSecret) {
    try {
        const incomingSignature = payload?.signature;
        if (!incomingSignature) return false;
        const withoutSig = { ...payload };
        delete withoutSig.signature;
        const expected = crypto.createHmac('sha256', webhookSecret).update(JSON.stringify(withoutSig)).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(incomingSignature, 'hex'));
    } catch { return false; }
}

async function getRawBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
}

async function sendTelegramMessage(token, chatId, text) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
}
