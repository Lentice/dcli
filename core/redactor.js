const KEY_PATTERNS = [
  { pattern: /^authorization$/i, label: 'authorization' },
  { pattern: /^api[-_]?key$/i, label: 'api_key' },
  { pattern: /^token$/i, label: 'token' },
  { pattern: /^secret$/i, label: 'secret' },
  { pattern: /^password$/i, label: 'password' },
  { pattern: /^bearer$/i, label: 'bearer' },
  { pattern: /^auth\.json$/i, label: 'auth_json' },
];

class Redactor {
  constructor() {
    this._exactValues = new Map();
    this._keyPatterns = KEY_PATTERNS;
  }

  registerSecret(name, value) {
    if (typeof value !== 'string' || value.length === 0) return;
    this._exactValues.set(value, `\u00abredacted:${name}\u00bb`);
  }

  redactText(text) {
    if (typeof text !== 'string') return text;
    let result = text;
    for (const [value, placeholder] of this._exactValues) {
      let idx = -1;
      while ((idx = result.indexOf(value, idx + 1)) !== -1) {
        result = result.slice(0, idx) + placeholder + result.slice(idx + value.length);
        idx += placeholder.length - 1;
      }
    }
    return result;
  }

  redactValue(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return this._redactStringValue(value);
    if (Array.isArray(value)) {
      return value.map(v => this.redactValue(v));
    }
    if (typeof value === 'object') {
      const result = {};
      for (const key of Object.keys(value)) {
        const matchedPattern = this._matchKeyPattern(key);
        let val = this.redactValue(value[key]);
        if (matchedPattern && typeof val === 'string') {
          val = `\u00abredacted:${matchedPattern}\u00bb`;
        }
        result[key] = val;
      }
      return result;
    }
    return value;
  }

  redactJson(value) {
    return this.redactValue(value);
  }

  createSanitizingRedactor() {
    const r = new Redactor();
    for (const [value, placeholder] of this._exactValues) {
      r._exactValues.set(value, placeholder);
    }
    r._keyPatterns = this._keyPatterns;
    return r;
  }

  _redactStringValue(str) {
    for (const [value, placeholder] of this._exactValues) {
      let idx = -1;
      while ((idx = str.indexOf(value, idx + 1)) !== -1) {
        str = str.slice(0, idx) + placeholder + str.slice(idx + value.length);
        idx += placeholder.length - 1;
      }
    }
    return str;
  }

  _matchKeyPattern(key) {
    for (const entry of this._keyPatterns) {
      if (entry.pattern.test(key)) {
        return entry.label;
      }
    }
    return null;
  }
}

module.exports = { Redactor };
