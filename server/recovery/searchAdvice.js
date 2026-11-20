// Advice describes possible information to recover. It never mutates rules or
// guesses an answer. Estimates cover the entire selected space, before reuse.
function searchAdvice(config, summary, measurement = null) {
  const rules = config.guided;
  const exact = summary.candidateCountExact || String(summary.uniqueCandidateCount);
  const count = Number(exact);
  const measured = measurement && Number.isFinite(measurement.guessesPerSecond)
    && measurement.guessesPerSecond > 0;
  const estimate = {
    source: measured ? 'measured' : 'illustrative',
    guessesPerSecond: measured ? measurement.guessesPerSecond : null,
    seconds: measured ? count / measurement.guessesPerSecond : null,
    measuredAt: measured ? measurement.measuredAt || null : null,
    scenarios: measured ? [] : [1, 10, 100].map((guessesPerSecond) => ({
      guessesPerSecond, seconds: count / guessesPerSecond
    })),
    includesReuse: false,
    description: 'Full selected search, before subtracting reusable checks. A match may appear at any point or may be outside this selection. Lookup and disk overhead can add time.'
  };
  const coverage = [
    `Selected password lengths: ${rules.minLength}–${rules.maxLength}. Lengths outside this interval are excluded.`,
    'Rhyming and correct spelling are not assumed. Include misspellings, invented strings, and every plausible alternative.'
  ];
  const questions = [];
  const ask = (id, prompt, reason) => questions.push({ id, prompt, reason });
  if (rules.maxLength !== rules.minLength) {
    ask('length', 'What is the complete range of lengths you can confidently include?',
      'Each additional unknown position multiplies its branch by the allowed alphabet size. Keep every plausible length; a rough memory is not an exact length.');
  }
  if (rules.searchMode === 'mask') {
    coverage.push('Only the union of the entered patterns is searched. Blank patterns include every allowed character at each position within the selected lengths.');
    coverage.push('Letters may have any spelling and case. The general unknown character includes English letters, digits, punctuation, and space; other Unicode characters are excluded.');
    ask('positions', 'Do you remember any exact characters and all their possible positions?',
      'Fixing one otherwise unknown position can reduce that branch by about 95 times. Enter separate alternatives for uncertain positions or spellings; leave the broad pattern if you cannot rule those out.');
    ask('classes', 'At any position, can you rule out an entire character class with confidence?',
      'Lowercase, uppercase, either-case letters, digits, and punctuation can be specified separately. Choosing digits for one fully unknown position reduces its branch by about 9.5 times.');
    ask('boundaries', 'Are the start, end, or separators known, including possible alternatives?',
      'Exact prefixes and suffixes can reduce work substantially without requiring dictionary words. Preserve uncertain characters as wildcards.');
    ask('alternatives', 'Could case, a typo, a repeated character, or another placement be different?',
      'Add all plausible patterns before preparing. Alternatives form a union; one pattern never has to satisfy another pattern.');
  } else {
    coverage.push('This is a two-fragment search: only the supplied letter strings and selected layouts are covered. Arbitrary character arrangements require pattern mode.');
    coverage.push(`Digits: ${rules.minDigits}–${rules.maxDigits}; trailing symbols: ${rules.minSymbols}–${rules.maxSymbols}; symbol alphabet: ${rules.symbols.length} distinct characters.`);
    coverage.push(`Selected capitalization styles: ${rules.caseStyles.join(', ')}. Styles apply to both fragments together; independent mixed case requires an explicit pattern.`);
    coverage.push(`Selected layouts: ${rules.layouts.join(', ')}. Symbols occur only at the end in these layouts.`);
    ask('fragments', 'Which letter fragments and spelling variants could actually have been entered?',
      'Include invented strings, typos, repeated letters, and both orders if uncertain. Lists are an explicit hypothesis, not a complete dictionary.');
    ask('fragment_lengths', 'Can you confidently bound either fragment’s letter count?',
      'These bounds remove entire pairs before generating digits or symbols. Leave wide ranges for uncertain memories.');
    ask('counts', 'Which digit and symbol counts are possible, including zero?',
      'Every extra digit in all-combinations mode multiplies that branch by ten; each extra symbol multiplies it by the symbol alphabet size.');
    ask('digit_values', 'Can you confidently bound every contiguous digit run?',
      'A value bound includes leading zeroes but applies separately to both runs in split layouts. Use patterns instead if a remembered number might span a different arrangement.');
    ask('symbols', 'Which symbols can you definitely exclude, including unshifted punctuation?',
      'A remembered example is not evidence that other symbols are impossible. Keep the full set unless certain.');
    ask('structure', 'Could capitalization, fragment order, digit placement, or symbol placement differ?',
      'These controls exclude whole structures. Use general patterns when the two-fragment arrangement is only a guess.');
    if (rules.digitMode === 'repeated' || rules.symbolMode === 'repeated') {
      coverage.push('Repeated-only mode excludes mixed characters within the affected runs.');
    }
    if (rules.requireDistinctWords) coverage.push('Pairs containing the same letter string twice are excluded.');
    if (rules.sharedEnding) coverage.push('This legacy job restricts shared endings. New searches do not assume rhymes.');
    if (rules.digitMin > 0 || rules.digitMax !== null) {
      coverage.push(`Every contiguous digit run is bounded from ${rules.digitMin} to ${rules.digitMax ?? 'its full maximum'}.`);
    }
    coverage.push(`First fragment length: ${rules.word1MinLen}–${rules.word1MaxLen}; second: ${rules.word2MinLen}–${rules.word2MaxLen}.`);
  }
  const warnings = [
    'Unknown answers should remain broad. If a memory is only a hunch, keep it in the memory notes or include every alternative; do not make it a required filter.',
    estimate.description
  ];
  if (summary.runnable === false) warnings.push('This space is too large for an indexed job. The exact count is still shown; recover more information before preparing. No candidates have been discarded to make it fit.');
  if (!measured) warnings.push('The speeds below are examples, not a measurement of your wallet. Measure wallet speed for a machine-specific estimate.');
  return { estimate, coverage, questions, warnings };
}

module.exports = { searchAdvice };
