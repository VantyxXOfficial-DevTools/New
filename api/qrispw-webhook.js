import crypto from 'crypto';

export default async function handler(req, res) {

    // TEST GET
    if (req.method === 'GET') {
        return res.status(200).json({
            status: 'ok',
            service: 'VXO QRIS Webhook',
            time: new Date().toISOString()
        });
    }

    // ONLY POST
    if (req.method !== 'POST') {
        return res.status(405).json({
            error: 'Method not allowed'
        });
    }

    // READ RAW BODY
    let rawBody = '';

    try {
        rawBody = await getRawBody(req);
    } catch (e) {
        return res.status(400).json({
            error: 'Cannot read body'
        });
    }

    // PARSE JSON
    let payload;

    try {
        payload = JSON.parse(rawBody);
    } catch (e) {
        return res.status(400).json({
            error: 'Invalid JSON'
        });
    }

    // VERIFY SIGNATURE
    const webhookSecret = process.env.QRISPW_WEBHOOK_SECRET || '';

    if (webhookSecret) {

        const valid = verifySignature(payload, webhookSecret);

        if (!valid) {
            console.log('INVALID SIGNATURE');

            return res.status(401).json({
                error: 'Invalid signature'
            });
        }
    }

    const {
        transaction_id,
        order_id,
        amount,
        status,
        paid_at
    } = payload;

    console.log('PAYMENT:', transaction_id);

    // ONLY PROCESS PAID
    if (status !== 'paid') {
        return res.status(200).json({
            received: true,
            ignored: true,
            status
        });
    }

    // PARSE ORDER ID
    // FORMAT:
    // VXOPAY-123456-premium-1746

    const parsed = parseOrderId(order_id);

    if (!parsed) {
        return res.status(400).json({
            error: 'Invalid order_id format'
        });
    }

    const {
        userId,
        packageId
    } = parsed;

    // MESSAGE
    const message = [
        `💸 <b>PAYMENT BERHASIL</b>`,
        ``,
        `🆔 <b>TRX:</b> <code>${transaction_id}</code>`,
        `👤 <b>User:</b> <code>${userId}</code>`,
        `📦 <b>Package:</b> <code>${packageId}</code>`,
        `💰 <b>Amount:</b> Rp${Number(amount).toLocaleString('id-ID')}`,
        `📅 <b>Paid:</b> ${paid_at || '-'}`,
        ``,
        `✅ Payment sukses diterima`
    ].join('\n');

    // TELEGRAM ENV
    const botToken  = process.env.BOT_TOKEN || '';
    const ownerId   = process.env.OWNER_ID || '';
    const channelId = process.env.CHANNEL_ID || '';

    // SEND PRIVATE
    if (botToken && ownerId) {
        try {
            await sendTelegramMessage(
                botToken,
                ownerId,
                message
            );
        } catch (e) {
            console.log('OWNER ERROR:', e.message);
        }
    }

    // SEND CHANNEL
    if (botToken && channelId) {
        try {
            await sendTelegramMessage(
                botToken,
                channelId,
                message
            );
        } catch (e) {
            console.log('CHANNEL ERROR:', e.message);
        }
    }

    return res.status(200).json({
        success: true,
        transaction_id,
        userId,
        packageId
    });
}

// ─────────────────────────────
// HELPERS
// ─────────────────────────────

function parseOrderId(orderId) {

    const m = String(orderId || '')
        .match(/^VXOPAY-(\d+)-(.+?)-\d+$/);

    if (!m) return null;

    return {
        userId: m[1],
        packageId: m[2]
    };
}

function verifySignature(payload, secret) {

    try {

        const incoming = payload.signature;

        if (!incoming) return false;

        const data = {
            ...payload
        };

        delete data.signature;

        const expected = crypto
            .createHmac('sha256', secret)
            .update(JSON.stringify(data))
            .digest('hex');

        return crypto.timingSafeEqual(
            Buffer.from(expected, 'hex'),
            Buffer.from(incoming, 'hex')
        );

    } catch {
        return false;
    }
}

async function getRawBody(req) {

    return new Promise((resolve, reject) => {

        let data = '';

        req.on('data', chunk => {
            data += chunk;
        });

        req.on('end', () => {
            resolve(data);
        });

        req.on('error', reject);

    });
}

async function sendTelegramMessage(token, chatId, text) {

    await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: 'HTML'
            })
        }
    );
}
