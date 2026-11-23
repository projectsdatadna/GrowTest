/**
 * Suggested Stoploss / Target for one symbol, the same formulas as the "Stp &
 * Target Sample" sheet (Sheet1), with the two ₹ amounts as absolute inputs:
 *   Stoploss     = stoploss ₹ / lot size          (price points per share)
 *   Stoploss %   = Stoploss / stock price * 100
 *   Target       = target ₹ / lot size
 *   Target %     = Target / stock price * 100
 * Any figure that cannot be computed (no amount, no lot size, no price) is null.
 */

const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0

export function computeStopTarget({ slAmount, targetAmount, lotSize, price }) {
  const out = { stoploss: null, stoplossPct: null, target: null, targetPct: null }
  if (!positive(lotSize)) return out
  if (positive(slAmount)) {
    out.stoploss = slAmount / lotSize
    if (positive(price)) out.stoplossPct = (out.stoploss / price) * 100
  }
  if (positive(targetAmount)) {
    out.target = targetAmount / lotSize
    if (positive(price)) out.targetPct = (out.target / price) * 100
  }
  return out
}

// Stock price used for the percentages: live quote, else the sheet's price, else the bar close.
export function pickStockPrice({ quote, sheetPrice, closePrice }) {
  for (const [value, source] of [[quote?.lastPrice, 'live'], [sheetPrice, 'sheet'], [closePrice, 'close']]) {
    if (positive(value)) return { price: value, source }
  }
  return { price: null, source: null }
}

// Input text -> positive number or null (accepts "7,500" and "₹7500").
export function parseAmount(text) {
  const n = Number(String(text ?? '').replace(/[₹,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}
