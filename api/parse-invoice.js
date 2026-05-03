// api/parse-invoice.js
// ----------------------------------------------------------------------------
// Hardened invoice parser: JWT auth, CORS lock, rate limit, tool-use output.
// Required env vars (set in Vercel > Settings > Environment Variables):
//   ANTHROPIC_API_KEY          - your Anthropic key
//   SUPABASE_URL               - https://xxxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  - service-role key from Supabase > Settings > API
//   ALLOWED_ORIGIN             - e.g. https://your-app.vercel.app
// ----------------------------------------------------------------------------

const { createClient } = require('@supabase/supabase-js');

// Tool schema — Anthropic guarantees the model returns args matching this.
const RECORD_INVOICE_TOOL = {
  name: 'record_invoice',
  description: 'Record the parsed contents of a restaurant food-service invoice.',
  input_schema: {
    type: 'object',
    properties: {
      vendor_name:    { type: 'string' },
      invoice_number: { type: ['string', 'null'] },
      invoice_date:   { type: ['string', 'null'], description: 'ISO date (YYYY-MM-DD) if visible' },
      total_amount:   { type: ['number', 'null'] },
      line_items: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          properties: {
            sku:                { type: ['string', 'null'] },
            description:        { type: 'string' },
            quantity:           { type: 'number' },
            unit_price:         { type: 'number', description: 'NET unit price after any TDP discount' },
            gross_price:        { type: 'number', description: 'Original unit price before any TDP discount' },
            tdp_discount:       { type: 'number', description: 'TDP per-unit discount, 0 if none' },
            extended_price:     { type: ['number', 'null'] },
            unit:               { type: 'string' },
            is_short:           { type: 'boolean', description: 'True if this is a short/missing line' },
            is_credit:          { type: 'boolean', description: 'True if this line is a credit/return' },
            inventory_category: {
              type: 'string',
              enum: ['Produce','Protein','Dairy','Dry Goods','Chemical',
                     'Beverage','Bakery','Frozen','Paper/Disposables','Other']
            }
          },
          required: ['description','quantity','unit_price','unit','inventory_category']
        }
      }
    },
    required: ['vendor_name','line_items']
  }
};

const PROMPT = `Parse this restaurant food-service invoice and call the record_invoice tool with the result.

RULES:
1. TDP lines (Trade Discount Program) are discounts that apply to the item IMMEDIATELY ABOVE them. Subtract the TDP unit amount from that item's unit_price to compute the NET unit_price. Put the original price in gross_price and the per-unit TDP amount in tdp_discount. Do NOT emit TDP lines as their own line item.
2. is_short = true if the line indicates the item was not delivered (e.g. "SHORT", quantity zero with note).
3. is_credit = true if the line is a credit, return, or negative amount.
4. Pick the best inventory_category from the enum.
5. Call the tool exactly once. Do not write any prose.`;

// ---------- Helpers ---------------------------------------------------------

function setCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function checkRateLimit(supabase, userId) {
  // Allow 20 calls per user per 10 minutes. Adjust as you like.
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('parse_invoice_calls')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('called_at', tenMinAgo);
  if (error) {
    console.error('Rate-limit query failed:', error.message);
    return { ok: true }; // Fail-open on infra errors so users aren't locked out.
  }
  if ((count || 0) >= 20) {
    return { ok: false, retryAfter: 600 };
  }
  await supabase.from('parse_invoice_calls').insert({ user_id: userId });
  return { ok: true };
}

// ---------- Handler ---------------------------------------------------------

module.exports = async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
  const reqOrigin = req.headers.origin || '';
  // Only echo back the origin if it matches what we allow.
  const corsOrigin = (allowedOrigin && reqOrigin === allowedOrigin) ? allowedOrigin : allowedOrigin;
  setCors(res, corsOrigin);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  // Reject browser requests from unexpected origins (defense in depth).
  if (allowedOrigin && reqOrigin && reqOrigin !== allowedOrigin) {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }

  try {
    // ── Env validation ────────────────────────────────────────────
    const apiKey   = process.env.ANTHROPIC_API_KEY;
    const sbUrl    = process.env.SUPABASE_URL;
    const sbSrvKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!apiKey)   { res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY env' }); return; }
    if (!sbUrl || !sbSrvKey) { res.status(500).json({ error: 'Missing Supabase env vars' }); return; }

    // ── Auth: verify Supabase JWT ─────────────────────────────────
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) { res.status(401).json({ error: 'Missing bearer token' }); return; }

    const supabase = createClient(sbUrl, sbSrvKey, { auth: { persistSession: false } });
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }
    const userId = userData.user.id;

    // ── Rate limit ────────────────────────────────────────────────
    const rl = await checkRateLimit(supabase, userId);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter || 60));
      res.status(429).json({ error: 'Rate limit exceeded. Try again in a few minutes.' });
      return;
    }

    // ── Body validation ───────────────────────────────────────────
    const body = req.body || {};
    const { base64Data, mediaType = 'image/jpeg' } = body;
    if (!base64Data || typeof base64Data !== 'string') {
      res.status(400).json({ error: 'Missing base64Data' });
      return;
    }
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(mediaType)) {
      res.status(400).json({ error: 'Unsupported media type: ' + mediaType });
      return;
    }
    // Hard cap on size (4 MB of base64 ≈ 3 MB raw)
    if (base64Data.length > 5_500_000) {
      res.status(413).json({ error: 'File too large after encoding. Compress before upload.' });
      return;
    }

    // ── Build Anthropic request ───────────────────────────────────
    const isPdf = mediaType === 'application/pdf';
    const messageContent = [
      isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
        : { type: 'image',    source: { type: 'base64', media_type: mediaType,         data: base64Data } },
      { type: 'text', text: PROMPT }
    ];

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',           // structured extraction — Sonnet is plenty
        max_tokens: 8192,
        tools: [RECORD_INVOICE_TOOL],
        tool_choice: { type: 'tool', name: 'record_invoice' },
        messages: [{ role: 'user', content: messageContent }]
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error('Anthropic error', anthropicRes.status, errText.slice(0, 500));
      res.status(502).json({
        error: 'Upstream parser error',
        status: anthropicRes.status,
        detail: errText.slice(0, 300)
      });
      return;
    }

    const claudeData = await anthropicRes.json();

    // Detect truncation explicitly so the user gets a useful message.
    if (claudeData.stop_reason === 'max_tokens') {
      res.status(502).json({
        error: 'Invoice too long for the model to finish in one pass. Try splitting it.'
      });
      return;
    }

    // Pull the tool_use block — guaranteed by tool_choice.
    const toolBlock = (claudeData.content || []).find(b => b.type === 'tool_use');
    if (!toolBlock || !toolBlock.input) {
      res.status(502).json({
        error: 'Parser did not return structured data',
        stop_reason: claudeData.stop_reason
      });
      return;
    }

    res.status(200).json(toolBlock.input);

  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({
      error: err.message || 'Internal error',
      stack: process.env.NODE_ENV === 'development' && err.stack ? err.stack.slice(0, 500) : undefined
    });
  }
};
