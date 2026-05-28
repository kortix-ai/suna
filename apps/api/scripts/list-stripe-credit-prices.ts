import { getStripe } from '../src/shared/stripe';

async function main() {
  const stripe = getStripe();
  const prices = await stripe.prices.list({ limit: 100, active: true, expand: ['data.product'] });
  const oneTime = prices.data.filter((p) => p.type === 'one_time');
  if (oneTime.length === 0) {
    console.log('No one-time prices found in current Stripe account.');
    return;
  }
  console.log(`Found ${oneTime.length} active one-time price(s):\n`);
  for (const p of oneTime) {
    const amount = (p.unit_amount ?? 0) / 100;
    const product = typeof p.product === 'object' && p.product && 'name' in p.product
      ? (p.product as { name?: string }).name
      : String(p.product);
    console.log(`  ${p.id}  $${amount.toFixed(2).padStart(8)}  ${(p.currency ?? '').toUpperCase()}  nickname=${p.nickname ?? '-'}  product=${product}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
