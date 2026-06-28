/**
 * BlackFossil — PayPal-Abo-Setup (einmalig ausführen)
 *
 * Legt 1 Product + die 3 Subscription-Pläne (Knochen/Bernstein/Obsidian) an
 * und gibt dir die Plan-IDs aus, die du in die token-service-.env einträgst.
 *
 * Voraussetzung: REST-App im PayPal-Developer-Dashboard erstellt → Client-ID + Secret.
 *
 * Aufruf (im Ordner token-service/):
 *   PAYPAL_ENV=sandbox \
 *   PAYPAL_CLIENT_ID=xxx PAYPAL_CLIENT_SECRET=yyy \
 *   node scripts/paypal-setup.mjs
 *
 * Erst mit PAYPAL_ENV=sandbox testen, dann mit PAYPAL_ENV=live (oder weglassen) live anlegen.
 */

const ENV    = process.env.PAYPAL_ENV ?? 'live';
const API    = ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
const ID     = process.env.PAYPAL_CLIENT_ID;
const SECRET = process.env.PAYPAL_CLIENT_SECRET;

if (!ID || !SECRET) {
  console.error('❌ PAYPAL_CLIENT_ID und PAYPAL_CLIENT_SECRET müssen gesetzt sein.');
  process.exit(1);
}

// Die 3 Ränge. Preise = Brutto in EUR (PayPal führt keine USt für dich ab — siehe Steuer-Hinweis).
const TIERS = [
  { env: 'PAYPAL_PLAN_KNOCHEN',   name: 'BlackFossil Rang — Knochen',   price: '4.99'  },
  { env: 'PAYPAL_PLAN_BERNSTEIN', name: 'BlackFossil Rang — Bernstein', price: '9.99'  },
  { env: 'PAYPAL_PLAN_OBSIDIAN',  name: 'BlackFossil Rang — Obsidian',  price: '19.99' },
];

async function token() {
  const auth = Buffer.from(`${ID}:${SECRET}`).toString('base64');
  const r = await fetch(`${API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`Token-Fehler ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

async function api(t, path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  console.log(`🔧 PayPal-Setup (${ENV.toUpperCase()})…\n`);
  const t = await token();

  // 1) Product (der "Abo-Service", unter dem alle Pläne hängen)
  const product = await api(t, '/v1/catalogs/products', {
    name: 'BlackFossil Supporter-Ränge',
    description: 'Monatliche Unterstützer-Ränge für den BlackFossil The-Isle-Server (Komfort-/Kosmetik-Perks).',
    type: 'SERVICE',
    category: 'ONLINE_GAMING',
  });
  console.log(`✅ Product: ${product.id}\n`);

  // 2) Pläne
  const out = [];
  for (const tier of TIERS) {
    const plan = await api(t, '/v1/billing/plans', {
      product_id: product.id,
      name: tier.name,
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0, // 0 = läuft unbegrenzt monatlich weiter
        pricing_scheme: { fixed_price: { value: tier.price, currency_code: 'EUR' } },
      }],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee: { value: '0', currency_code: 'EUR' },
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 1,
      },
    });
    out.push({ env: tier.env, id: plan.id, name: tier.name, price: tier.price });
    console.log(`✅ ${tier.name}: ${plan.id}`);
  }

  console.log('\n────────────────────────────────────────────');
  console.log('Diese Werte in die token-service-.env eintragen:\n');
  for (const p of out) console.log(`${p.env}=${p.id}`);
  console.log('\nUnd in die Website (Web/assets/abo.js) die Plan-IDs + Client-ID setzen.');
  console.log('────────────────────────────────────────────');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
