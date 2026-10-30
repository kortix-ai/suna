/**
 * The mobile-app promo's art gradient, sampled from the eclipse orb it is
 * modelled on: bone at the top, a red horizon, navy, then black. One art value,
 * so its raw colours live in this one module. `in oklab` keeps the brightness
 * even through the band. Read by the promo modal's art panel and the download
 * page's Desktop card, so both surfaces share one backdrop.
 */
// prettier-ignore
export const PROMO_GRADIENT = 'linear-gradient(170deg in oklab, #DAD9D5 0%, #DAD9D5 34%, #943637 50%, #1D1F2C 60%, #000 82%)';
