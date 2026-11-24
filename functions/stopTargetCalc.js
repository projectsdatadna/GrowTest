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

// Stock price used for the percentages: the live quote, else the card's bar close (recent), else the
// price in the uploaded sheet (a snapshot that can be weeks old, so it is the last resort).
export function pickStockPrice({ quote, closePrice, sheetPrice }) {
  for (const [value, source] of [[quote?.lastPrice, 'live'], [closePrice, 'close'], [sheetPrice, 'sheet']]) {
    if (positive(value)) return { price: value, source }
  }
  return { price: null, source: null }
}

/**
 * What the Suggested SL / Target column of a Notifications card shows. Pure (no rendering) so every state is tested.
 *   state 'off'   no Stoploss / Target amount entered -> the column is not shown at all
 *   state 'noLot' the symbol has no lot size: `reason` says why (an index without futures cannot have one;
 *                 for a stock it is missing from the uploaded sheet)
 *   state 'ok'    lotSize, stoploss(+Pct) and target(+Pct) (each null when its amount is missing), price + priceSource
 */
export function describeStopTarget({ group, quote, slAmount, targetAmount }) {
  if (!positive(slAmount) && !positive(targetAmount)) return { state: 'off' }
  const lotSize = positive(group?.lotSize) ? group.lotSize : null
  if (lotSize == null) return { state: 'noLot', reason: group?.isIndex ? 'index' : 'sheet' }
  const { price, source: priceSource } = pickStockPrice({ quote, closePrice: group.closePrice, sheetPrice: group.sheetPrice })
  return { state: 'ok', lotSize, price, priceSource, ...computeStopTarget({ slAmount, targetAmount, lotSize, price }) }
}

// Input text -> positive number or null (accepts "7,500" and "₹7500").
export function parseAmount(text) {
  const n = Number(String(text ?? '').replace(/[₹,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * A lot size typed by the user ("1,150", 1150) or sent to the lot-size route ->
 * { value: positive whole number } to set it, { value: null } to reset it (empty / null), or { error }.
 */
export function parseLotSize(raw) {
  if (raw === null || raw === undefined || raw === '') return { value: null }
  const error = { error: 'The lot size must be a whole number greater than 0, or empty to reset it' }
  if (typeof raw === 'boolean') return error
  const n = typeof raw === 'string' ? Number(raw.replace(/[,\s]/g, '')) : raw
  return Number.isInteger(n) && n > 0 && n <= 10000000 ? { value: n } : error
}
