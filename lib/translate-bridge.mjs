/**
 * Translate bridge (Phase 3) — the seam between the P2P room and on-device QVAC NMT.
 *
 * Translation is a LOCAL, READ-TIME transform. The Autobase log keeps the ORIGINAL chat
 * text (canonical, multi-writer, untouched); each peer translates incoming lines into
 * THEIR chosen language only at display time. Nothing translated is ever written back to
 * shared state. room.js has no QVAC deps — all @qvac/sdk calls live here.
 *
 * Inference is 100% on-device: QVAC loads a small Bergamot NMT model (fetched once from
 * its P2P registry, then cached on disk) and runs it in a local Bare worker. There is no
 * translation API/endpoint anywhere.
 *
 * Docs: https://docs.qvac.tether.io  — API confirmed against @qvac/sdk 0.14.x:
 *   loadModel({ modelSrc: BERGAMOT_XX_YY, modelConfig: { engine:'Bergamot', from, to, ... } })
 *   translate({ modelId, text, modelType:'nmtcpp-translation', stream:false }).text  // a Promise
 *   unloadModel({ modelId })
 */

import * as QVAC from '@qvac/sdk'

const { loadModel, translate, unloadModel } = QVAC

/** Resolve the Bergamot model-source constant for a language pair, e.g. en/fr -> BERGAMOT_EN_FR. */
function modelSrcFor (from, to) {
  const key = `BERGAMOT_${from.toUpperCase()}_${to.toUpperCase()}`
  const src = QVAC[key]
  if (!src) throw new Error(`no Bergamot model for ${from}->${to} (${key}); pick a supported pair`)
  return src
}

/**
 * A per-peer translator. Set the peer's preferred language; feed it incoming chat lines
 * (assumed English-canonical by default) and it returns them in the peer's language.
 * Models are loaded lazily per pair; results are cached per (from,to,text).
 */
export class Translator {
  constructor ({ targetLang }) {
    this.target = targetLang
    this._models = new Map() // "en>fr" -> modelId
    this._cache = new Map() // "en>fr:text" -> translated
  }

  async _modelId (from, to) {
    const k = `${from}>${to}`
    if (this._models.has(k)) return this._models.get(k)
    const modelId = await loadModel({
      modelSrc: modelSrcFor(from, to),
      modelConfig: { engine: 'Bergamot', from, to, beamsize: 1, temperature: 0.2 }
    })
    this._models.set(k, modelId)
    return modelId
  }

  /** Translate one line into this peer's language. Same-language input passes through. */
  async translate (text, { from = 'en' } = {}) {
    if (!text) return text
    if (from === this.target) return text // e.g. an English reader on English chat
    const ck = `${from}>${this.target}:${text}`
    if (this._cache.has(ck)) return this._cache.get(ck)
    const modelId = await this._modelId(from, this.target)
    const out = await translate({ modelId, text, modelType: 'nmtcpp-translation', stream: false }).text
    this._cache.set(ck, out)
    return out
  }

  /** Localize a room's message list for display (originals untouched). */
  async localize (messages, { from = 'en' } = {}) {
    const out = []
    for (const m of messages) {
      out.push({ peer: m.peer, original: m.text, translated: await this.translate(m.text, { from }) })
    }
    return out
  }

  async close () {
    for (const id of this._models.values()) {
      try { await unloadModel({ modelId: id }) } catch { /* ignore */ }
    }
    this._models.clear()
  }
}
