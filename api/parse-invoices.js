const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Log everything for debugging
  console.log('Method:', req.method);
  console.log('Body keys:', req.body ? Object.keys(req.body) : 'no body');
  console.log('Has API key:', !!process.env.ANTHROPIC_API_KEY);

  try {
    const body = req.body || {};
    const base64Data = body.base64Data;
    const mediaType = body.mediaType || 'image/jpeg';
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) { res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY env var' }); return; }
    if (!base64Data) { res.status(400).json({ error: 'Missing base64Data', receivedKeys: Object.keys(body) }); return; }

    console.log('Base64 length:', base64Data.length);
    console.log('Media type:', mediaType);

    const isPdf = mediaType === 'application/pdf';
    const messageContent = [
      isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
        : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
      { type: 'text', text: `Parse this restaurant food-service invoice.

IMPORTANT RULES:
1. TDP lines (Trade Discount Program) are discounts that apply to the item IMMEDIATELY ABOVE them. Subtract the TDP unit amount from that item's unit_price to get the NET unit price. Do not include TDP as a separate line item.
2. Return ONLY valid JSON, no markdown, no explanation.

Return this exact structure:
{
  "vendor_name": "string",
  "invoice_number": "string or null",
  "invoice_date": "string or null",
  "total_amount": number or null,
  "line_items": [
    {
      "sku": "string or null",
      "description": "string",
      "quantity": number,
      "unit_price": number (NET after any TDP discount applied),
      "gross_price": number (original price before TDP),
      "tdp_discount": number (TDP amount per unit, 0 if none),
      "extended_price": number or null,
      "unit": "string",
      "is_short": false,
      "is_credit": false,
      "inventory_category": "Produce|Protein|Dairy|Dry Goods|Chemical|Beverage|Bakery|Frozen|Paper/Disposables|Other"
    }
  ]
}` }
    ];

    const bodyStr = JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: messageContent }]
    });

    console.log('Calling Anthropic API...');

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(bodyStr)
        }
      };
      const r = https.request(options, (response) => {
        let data = '';
        response.on('data', c => data += c);
        response.on('end', () => {
          console.log('Anthropic status:', response.statusCode);
          console.log('Anthropic response length:', data.length);
          resolve({ status: response.statusCode, body: data });
        });
      });
      r.on('error', reject);
      r.setTimeout(55000, () => { r.destroy(); reject(new Error('Timeout')); });
      r.write(bodyStr);
      r.end();
    });

    const claudeData = JSON.parse(result.body);
    console.log('Claude stop_reason:', claudeData.stop_reason);
    console.log('Claude error:', claudeData.error);

    if (claudeData.error) {
      res.status(500).json({ error: claudeData.error.message, type: claudeData.error.type });
      return;
    }

    if (!claudeData.content || !claudeData.content[0]) {
      res.status(500).json({ error: 'No content block in response', raw: result.body.slice(0, 500) });
      return;
    }

    let text = claudeData.content[0].text || '';
    console.log('Response text length:', text.length);
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s === -1 || e === -1) {
      res.status(500).json({ error: 'No JSON in response', text: text.slice(0, 300) });
      return;
    }

    const parsed = JSON.parse(text.slice(s, e + 1));
    res.status(200).json(parsed);

  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: err.message, stack: err.stack ? err.stack.slice(0, 300) : null });
  }
};
