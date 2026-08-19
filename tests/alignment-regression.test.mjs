import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8')
const context = vm.createContext({})

const alignmentStart = html.indexOf('function normalizeToken')
const alignmentEnd = html.indexOf('let pendingSeek', alignmentStart)
assert.ok(alignmentStart >= 0 && alignmentEnd > alignmentStart)
vm.runInContext(html.slice(alignmentStart, alignmentEnd), context)

const transcript = {
  sentenceAlignment: [
    { text: 'des Morgens verkündet.', start: 22.44, end: 23.18 },
    { text: 'Sehr gerne, da muss ich darauf konzentrieren.', start: 23.18, end: 24.76 },
    { text: 'Einen schönen guten Morgen.', start: 28.38, end: 30 },
  ],
  wordAlignment: [
    { word: 'des', start: 22.44, end: 22.7 },
    { word: 'Morgens', start: 22.7, end: 23.16 },
    { word: 'verkündet.', start: 23.16, end: 23.18 },
    { word: 'Sehr', start: 23.18, end: 23.32 },
    { word: 'gerne,', start: 23.32, end: 23.56 },
    { word: 'da', start: 23.84, end: 23.98 },
    { word: 'muss', start: 23.98, end: 24.12 },
    { word: 'ich', start: 24.12, end: 24.18 },
    { word: 'darauf', start: 24.18, end: 24.3 },
    { word: 'konzentrieren.', start: 24.3, end: 24.76 },
    { word: 'Einen', start: 28.38, end: 29.26 },
    { word: 'schönen', start: 29.26, end: 29.62 },
    { word: 'guten', start: 29.62, end: 29.82 },
    { word: 'Morgen.', start: 29.82, end: 30 },
  ],
}

context.transcript = transcript
vm.runInContext('buildSentenceRenderMaps(transcript)', context)

assert.equal(transcript.sentenceAlignment[0].alignedWords.at(-1).word, 'verkündet.')
assert.equal(transcript.sentenceAlignment[1].alignedWords[0].word, 'Sehr')
assert.equal(
  transcript.sentenceAlignment[1].alignedWords.some((word) => word.word === 'verkündet.'),
  false,
)
assert.equal(transcript.sentenceAlignment[1].renderMap.length, 7)
assert.equal(transcript.sentenceAlignment[1].playbackStart, 23.18)

context.sentences = transcript.sentenceAlignment
// Reference (reading-listening-tools) sentence sync: the sentence whose
// [start, end] window contains the time; shared boundary favours the earlier
// sentence; gaps return null (sticky — caller keeps its last index); after
// the last sentence ends the last sentence stays.
assert.equal(vm.runInContext('findActiveSentenceWindowIndex(sentences, 23.179)', context), 0)
assert.equal(vm.runInContext('findActiveSentenceWindowIndex(sentences, 23.18)', context), 0)
assert.equal(vm.runInContext('findActiveSentenceWindowIndex(sentences, 24.76)', context), 1)
assert.equal(vm.runInContext('findActiveSentenceWindowIndex(sentences, 27)', context), null)
assert.equal(vm.runInContext('findActiveSentenceWindowIndex(sentences, 28.38)', context), 2)
assert.equal(vm.runInContext('findActiveSentenceWindowIndex(sentences, 30)', context), 2)
assert.equal(vm.runInContext('findActiveSentenceWindowIndex(sentences, 35)', context), 2)
assert.equal(vm.runInContext('findActiveSentenceWindowIndex(sentences, 21)', context), null)

context.wordAlignment = transcript.wordAlignment
// Reference word sync: the last flat wordAlignment word that has started;
// -1 before the first word, last word stays after the final word.
assert.equal(vm.runInContext('findActiveFlatWordIndex(wordAlignment, 22.4)', context), -1)
assert.equal(vm.runInContext('findActiveFlatWordIndex(wordAlignment, 23.0)', context), 1)
assert.equal(vm.runInContext('findActiveFlatWordIndex(wordAlignment, 23.17)', context), 2)
assert.equal(vm.runInContext('findActiveFlatWordIndex(wordAlignment, 24.76)', context), 9)
assert.equal(vm.runInContext('findActiveFlatWordIndex(wordAlignment, 30)', context), 13)

const imperfectAsr = {
  sentenceAlignment: [
    { text: 'Sehr wirklich gerne', start: 1, end: 2 },
  ],
  wordAlignment: [
    { text: 'Sehr', start: 1, end: 1.2 },
    { text: 'völlig', start: 1.2, end: 1.6 },
    { text: 'gerne', start: 1.6, end: 2 },
  ],
}
context.imperfectAsr = imperfectAsr
vm.runInContext('buildSentenceRenderMaps(imperfectAsr)', context)
// Reference (parseStructuredTranscript) behaviour: an unmatched token is left
// unmapped and does NOT consume the current word — "wirklich" matches nothing,
// so it maps to no word and the cursor stays put for "gerne".
assert.equal(
  imperfectAsr.sentenceAlignment[0].alignedWords.map((word) => word.text).join('|'),
  'Sehr|gerne',
)
assert.equal(imperfectAsr.sentenceAlignment[0].renderMap.length, 2)

// German umlaut fuzzy match — user case: transcript keeps "Hassköter", the
// force-aligner emits the diacritic-stripped "Hasskoter". Both the precomposed
// ö (U+00F6) and the decomposed form (o + U+0308, emitted by some editors)
// must map the FULL word. Whitespace-split tokens keep the trailing period
// attached (exactly like the reference), so the last token is "Hassköter.".
for (const umlaut of ['\u00F6', 'o\u0308']) {
  const umlautCase = {
    sentenceAlignment: [
      { text: `Guten Tag Frau von Hassk${umlaut}ter.`, start: 35.76, end: 36.96 },
    ],
    wordAlignment: [
      { word: 'Guten', start: 35.76, end: 35.92 },
      { word: 'Tag', start: 35.92, end: 36.16 },
      { word: 'Frau', start: 36.16, end: 36.32 },
      { word: 'von', start: 36.32, end: 36.48 },
      { word: 'Hasskoter', start: 36.48, end: 36.96 },
    ],
  }
  context.umlautCase = umlautCase
  vm.runInContext('buildSentenceRenderMaps(umlautCase)', context)
  const sentence = umlautCase.sentenceAlignment[0]
  assert.equal(sentence.renderMap.length, 5)
  assert.equal(sentence.alignedWords.at(-1).word, 'Hasskoter')
  const lastItem = sentence.renderMap.at(-1)
  const lastTokenText = sentence.text.slice(lastItem.startChar, lastItem.endChar)
  assert.equal(lastTokenText, `Hassk${umlaut}ter.`)
  assert.equal(sentence.text.slice(lastItem.endChar), '')
}

// Number separators — the force-aligner drops '-' and '.' and concatenates
// digits: "16-18" -> "1618", "13.000" -> "13000". Whitespace-split tokens keep
// the separator inside the token and the normalized form matches the ASR word.
const rangeNumber = {
  sentenceAlignment: [
    { text: 'insgesamt 16-18 Tage.', start: 9, end: 12 },
  ],
  wordAlignment: [
    { word: 'insgesamt', start: 9.28, end: 9.92 },
    { word: '1618', start: 9.92, end: 11.12 },
    { word: 'Tage', start: 11.12, end: 11.68 },
  ],
}
context.rangeNumber = rangeNumber
vm.runInContext('buildSentenceRenderMaps(rangeNumber)', context)
assert.equal(rangeNumber.sentenceAlignment[0].renderMap.length, 3)
assert.equal(
  rangeNumber.sentenceAlignment[0].alignedWords.map((word) => word.word).join('|'),
  'insgesamt|1618|Tage',
)

const thousandNumber = {
  sentenceAlignment: [
    { text: 'Auf dem Oktoberfest arbeiten jedes Jahr 13.000 Menschen.', start: 23.04, end: 27.36 },
  ],
  wordAlignment: [
    { word: 'Auf', start: 23.04, end: 23.28 },
    { word: 'dem', start: 23.28, end: 23.52 },
    { word: 'Oktoberfest', start: 23.52, end: 24.24 },
    { word: 'arbeiten', start: 24.24, end: 24.72 },
    { word: 'jedes', start: 25.2, end: 25.68 },
    { word: 'Jahr', start: 25.68, end: 25.84 },
    { word: '13000', start: 25.84, end: 26.72 },
    { word: 'Menschen', start: 26.72, end: 27.36 },
  ],
}
context.thousandNumber = thousandNumber
vm.runInContext('buildSentenceRenderMaps(thousandNumber)', context)
assert.equal(thousandNumber.sentenceAlignment[0].renderMap.length, 8)
assert.equal(
  thousandNumber.sentenceAlignment[0].alignedWords.at(-2).word,
  '13000',
)
assert.equal(thousandNumber.sentenceAlignment[0].alignedWords.at(-1).word, 'Menschen')

// Punctuation-only and separator-only tokens must never consume an ASR word:
// "16 - 18" (spaced separators) leaves 16/18 unmapped, "-" skipped, and "Tage"
// still maps to the correct word.
const spacedRange = {
  sentenceAlignment: [
    { text: '16 - 18 Tage', start: 0, end: 3 },
  ],
  wordAlignment: [
    { word: '1618', start: 0, end: 2 },
    { word: 'Tage', start: 2, end: 3 },
  ],
}
context.spacedRange = spacedRange
vm.runInContext('buildSentenceRenderMaps(spacedRange)', context)
assert.equal(spacedRange.sentenceAlignment[0].renderMap.length, 1)
assert.equal(spacedRange.sentenceAlignment[0].alignedWords[0].word, 'Tage')

const punctuationSkip = {
  sentenceAlignment: [
    { text: 'Hallo ... Welt', start: 0, end: 2 },
  ],
  wordAlignment: [
    { word: 'Hallo', start: 0, end: 1 },
    { word: 'Welt', start: 1, end: 2 },
  ],
}
context.punctuationSkip = punctuationSkip
vm.runInContext('buildSentenceRenderMaps(punctuationSkip)', context)
assert.equal(punctuationSkip.sentenceAlignment[0].renderMap.length, 2)
assert.equal(
  punctuationSkip.sentenceAlignment[0].alignedWords.map((word) => word.word).join('|'),
  'Hallo|Welt',
)

const renderStart = html.indexOf('function renderSentence(sentence, activeWord)')
const renderEnd = html.indexOf('// === Reset karaoke state', renderStart)
assert.ok(renderStart >= 0 && renderEnd > renderStart)
context.escapeHtml = (value) => String(value)
context.formatTime = (value) => `time:${value}`
context.showTranslation = false
vm.runInContext(html.slice(renderStart, renderEnd), context)
context.unmappedSentence = {
  text: 'Fallback sentence',
  start: 23.18,
  renderMap: [],
}
const fallbackHtml = vm.runInContext('renderSentence(unmappedSentence, null)', context)
assert.match(fallbackHtml, /karaoke-timestamp/)
assert.match(fallbackHtml, /time:23\.18/)
assert.match(fallbackHtml, /Fallback sentence/)

console.log('alignment regression tests passed')
