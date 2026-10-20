// No signing, wallet, approvals or transaction transport exists in this module.
export class PaperLedger {
  #balance;
  #entries = [];
  #seen = new Set();
  constructor(startingQuote) {
    if (typeof startingQuote !== 'bigint' || startingQuote < 0n) throw new TypeError('Invalid paper balance');
    this.#balance = startingQuote;
  }
  record(id, assessment) {
    if (typeof id !== 'string' || !id || this.#seen.has(id)) throw new Error('Invalid or duplicate simulation ID');
    if (!assessment || assessment.mode !== 'paper' || assessment.eligible !== true ||
        !Array.isArray(assessment.reasons) || assessment.reasons.length) throw new Error('Route rejected');
    const { input, quoteOut, gasQuote, bufferQuote, netQuote } = assessment;
    if ([input, quoteOut, gasQuote, bufferQuote, netQuote].some(x => typeof x !== 'bigint') ||
        input <= 0n || quoteOut < 0n || gasQuote < 0n || bufferQuote < 0n ||
        netQuote !== quoteOut - input - gasQuote - bufferQuote) throw new Error('Invalid assessment');
    if (input + gasQuote + bufferQuote > this.#balance) throw new Error('Insufficient paper balance');
    this.#balance += netQuote;
    this.#seen.add(id);
    this.#entries.push(Object.freeze({ id, netQuote, balanceQuote: this.#balance, simulated: true }));
    return this.#entries.at(-1);
  }
  get balanceQuote() { return this.#balance; }
  get entries() { return [...this.#entries]; }
}
