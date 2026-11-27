// The calculation lives in functions/ so the assistant's calc_stop_target tool (backend) and the
// Notifications cards (UI) share one implementation - see functions/stopTargetCalc.js.
export { computeStopTarget, pickStockPrice, parseAmount, parseLotSize, describeStopTarget } from '../../functions/stopTargetCalc.js'
