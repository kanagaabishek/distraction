// QVAC smoke test — does on-device Bergamot NMT actually run under Node here?
// Downloads the EN->FR model once (from QVAC's distributed registry), then translates locally.
import { loadModel, translate, unloadModel, BERGAMOT_EN_FR } from '@qvac/sdk'

const modelId = await loadModel({
  modelSrc: BERGAMOT_EN_FR,
  modelConfig: { engine: 'Bergamot', from: 'en', to: 'fr', beamsize: 1, temperature: 0.2 },
  onProgress: (p) => process.stderr.write(`\r  downloading ${p.percentage.toFixed(0)}%   `)
})
process.stderr.write('\n')
console.log('model loaded:', modelId)

const text = 'Come on England!'
const result = translate({ modelId, text, modelType: 'nmtcpp-translation', stream: false })
console.log('EN:', text)
console.log('FR:', await result.text)

await unloadModel({ modelId })
console.log('OK')
