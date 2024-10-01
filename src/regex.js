import {Context, hasUnescaped, replaceUnescaped} from 'regex-utilities';
import {CharClassContext, RegexContext, adjustNumberedBackrefs, capturingDelim, containsCharClassUnion, countCaptures, emulationGroupMarker, enclosedTokenCharClassContexts, enclosedTokenRegexContexts, escapeV, flagVSupported, getBreakoutChar, getEndContextForIncompleteExpression, patternModsSupported, preprocess, sandboxLoneCharClassCaret, sandboxLoneDoublePunctuatorChar, sandboxUnsafeNulls} from './utils.js';
import {Pattern, pattern} from './pattern.js';
import {flagNPreprocessor} from './flag-n.js';
import {flagXPreprocessor, cleanPlugin} from './flag-x.js';
import {atomicPlugin, possessivePlugin} from './atomic.js';
import {subroutinesPlugin} from './subroutines.js';
import {backcompatPlugin} from './backcompat.js';

/**
@typedef {string | RegExp | Pattern | number} InterpolatedValue
@typedef {{flags: string; useEmulationGroups: boolean;}} PluginData
@typedef {TemplateStringsArray | {raw: Array<string>}} RawTemplate
@typedef {{
  flags?: string;
  subclass?: boolean;
  plugins?: Array<(expression: string, data: PluginData) => string>;
  unicodeSetsPlugin?: ((expression: string, data: PluginData) => string) | null;
  disable?: {
    x?: boolean;
    n?: boolean;
    v?: boolean;
    atomic?: boolean;
    subroutines?: boolean;
  };
  force?: {
    v?: boolean;
  };
}} RegexTagOptions
*/
/**
@template T
@typedef RegexTag
@type {{
  (template: RawTemplate, ...substitutions: ReadonlyArray<InterpolatedValue>): T;
  (flags?: string): RegexTag<T>;
  (options: RegexTagOptions & {subclass?: false}): RegexTag<T>;
  (options: RegexTagOptions & {subclass: true}): RegexTag<WrappedRegExp>;
}}
*/
/**
Template tag for constructing a regex with extended syntax and context-aware interpolation of
regexes, strings, and patterns.

Can be called in several ways:
1. `` regex`…` `` - Regex pattern as a raw string.
2. `` regex('gi')`…` `` - To specify flags.
3. `` regex({flags: 'gi'})`…` `` - With options.
@type {RegexTag<RegExp>}
*/
const regex = (first, ...substitutions) => {
  // Given a template
  if (Array.isArray(first?.raw)) {
    return regexFromTemplate({}, first, ...substitutions);
  // Given flags
  } else if ((typeof first === 'string' || first === undefined) && !substitutions.length) {
    return regexFromTemplate.bind(null, {flags: first ?? ''});
  // Given an options object
  } else if ({}.toString.call(first) === '[object Object]' && !substitutions.length) {
    return regexFromTemplate.bind(null, first);
  }
  throw new Error(`Unexpected arguments: ${JSON.stringify([first, ...substitutions])}`);
}

/**
@template T
@typedef RegexFromTemplate
@type {{
  (options: RegexTagOptions, template: RawTemplate, ...substitutions: ReadonlyArray<InterpolatedValue>) : T;
}}
*/
/**
Returns a RegExp from a template and substitutions to fill the template holes.
@type {RegexFromTemplate<RegExp>}
*/
const regexFromTemplate = (options, template, ...substitutions) => {
  const opts = getOptions(options);
  const prepped = handlePreprocessors(template, substitutions, opts);

  let precedingCaptures = 0;
  let expression = '';
  let runningContext;
  // Intersperse raw template strings and substitutions
  prepped.template.raw.forEach((raw, i) => {
    const wrapEscapedStr = !!(prepped.template.raw[i] || prepped.template.raw[i + 1]);
    // Even with flag n enabled, we might have named captures
    precedingCaptures += countCaptures(raw);
    // Sandbox `\0` in character classes. Not needed outside character classes because in other
    // cases a following interpolated value would always be atomized
    expression += sandboxUnsafeNulls(raw, Context.CHAR_CLASS);
    runningContext = getEndContextForIncompleteExpression(expression, runningContext);
    const {regexContext, charClassContext} = runningContext;
    if (i < prepped.template.raw.length - 1) {
      const substitution = prepped.substitutions[i];
      expression += interpolate(substitution, opts.flags, regexContext, charClassContext, wrapEscapedStr, precedingCaptures);
      if (substitution instanceof RegExp) {
        precedingCaptures += countCaptures(substitution.source);
      } else if (substitution instanceof Pattern) {
        precedingCaptures += countCaptures(String(substitution));
      }
    }
  });

  expression = handlePlugins(expression, opts);
  if (opts.subclass) {
    const unmarked = unmarkEmulationGroups(expression);
    return new WrappedRegExp(unmarked.expression, opts.flags, {captureMap: unmarked.captureMap});
  }
  return new RegExp(expression, opts.flags);
}

/**
Returns the processed expression and flags as strings.
@param {string} expression
@param {RegexTagOptions} [options]
@returns {{expression: string; flags: string;}}
*/
function rewrite(expression = '', options = {}) {
  const opts = getOptions(options);
  if (opts.subclass) {
    // Don't allow including emulation group markers in output
    throw new Error('Cannot use option subclass');
  }
  return {
    expression: handlePlugins(
      handlePreprocessors({raw: [expression]}, [], opts).template.raw[0],
      opts
    ),
    flags: opts.flags,
  };
}

/**
Returns a complete set of options, with default values set for options that weren't provided, and
some options augmented for use.
@param {RegexTagOptions} options
@returns {Required<RegexTagOptions>}
*/
function getOptions(options) {
  const opts = {
    flags: '',
    subclass: false,
    plugins: [],
    unicodeSetsPlugin: backcompatPlugin,
    disable: {/* n, v, x, atomic, subroutines */},
    force: {/* v */},
    ...options,
  };
  if (/[nuvx]/.test(opts.flags)) {
    throw new Error('Implicit flags v/u/x/n cannot be explicitly added');
  }
  const useFlagV = opts.force.v || (opts.disable.v ? false : flagVSupported);
  opts.flags += useFlagV ? 'v' : 'u';
  if (useFlagV) {
    opts.unicodeSetsPlugin = null;
  }
  return opts;
}

/**
@param {RawTemplate} template
@param {ReadonlyArray<InterpolatedValue>} substitutions
@param {Required<RegexTagOptions>} options
@returns {{
  template: RawTemplate;
  substitutions: ReadonlyArray<InterpolatedValue>;
}}
*/
function handlePreprocessors(template, substitutions, options) {
  const preprocessors = [];
  // Implicit flag x is handled first because otherwise some regex syntax (if unescaped) within
  // comments could cause problems when parsing
  if (!options.disable.x) {
    preprocessors.push(flagXPreprocessor);
  }
  // Implicit flag n is a preprocessor because capturing groups affect backreference rewriting in
  // both interpolation and plugins
  if (!options.disable.n) {
    preprocessors.push(flagNPreprocessor);
  }
  for (const pp of preprocessors) {
    ({template, substitutions} = preprocess(template, substitutions, pp, options));
  }
  return {
    template,
    substitutions,
  };
}

/**
@param {string} expression
@param {Required<RegexTagOptions>} options
@returns {string}
*/
function handlePlugins(expression, options) {
  const {flags, plugins, unicodeSetsPlugin, disable, subclass} = options;
  [ ...plugins, // Run first, so provided plugins can output extended syntax
    ...(disable.subroutines ? [] : [subroutinesPlugin]),
    ...(disable.atomic      ? [] : [possessivePlugin, atomicPlugin]),
    ...(disable.x           ? [] : [cleanPlugin]),
    // Run last, so it doesn't have to worry about parsing extended syntax
    ...(!unicodeSetsPlugin  ? [] : [unicodeSetsPlugin]),
  ].forEach(p => expression = p(expression, {flags, useEmulationGroups: subclass}));
  return expression;
}

class WrappedRegExp extends RegExp {
  #captureMap;
  /**
  @param {string | WrappedRegExp} expression
  @param {string} [flags]
  @param {{captureMap: Array<boolean>;}} [data]
  */
  constructor(expression, flags, data) {
    super(expression, flags);
    if (data) {
      this.#captureMap = data.captureMap;
    // The third argument `data` isn't provided when regexes are copied as part of the internal
    // handling of string methods `matchAll` and `split`
    } else if (expression instanceof WrappedRegExp) {
      // Can read private properties of the existing object since it was created by this class
      this.#captureMap = expression.#captureMap;
    }
  }
  /**
  Called internally by all String/RegExp methods that use regexes.
  @override
  @param {string} str
  @returns {RegExpExecArray | null}
  */
  exec(str) {
    const match = RegExp.prototype.exec.call(this, str);
    if (!match || !this.#captureMap) {
      return match;
    }
    const copy = [...match];
    // Empty all but the first value of the array while preserving its other properties
    match.length = 1;
    for (let i = 1; i < copy.length; i++) {
      if (this.#captureMap[i]) {
        match.push(copy[i]);
      }
    }
    return match;
  }
}

/**
@param {InterpolatedValue} value
@param {string} flags
@param {string} regexContext
@param {string} charClassContext
@param {boolean} wrapEscapedStr
@param {number} precedingCaptures
@returns {string}
*/
function interpolate(value, flags, regexContext, charClassContext, wrapEscapedStr, precedingCaptures) {
  if (value instanceof RegExp && regexContext !== RegexContext.DEFAULT) {
    throw new Error('Cannot interpolate a RegExp at this position because the syntax context does not match');
  }
  if (regexContext === RegexContext.INVALID_INCOMPLETE_TOKEN || charClassContext === CharClassContext.INVALID_INCOMPLETE_TOKEN) {
    // Throw in all cases, but only *need* to handle a preceding unescaped backslash (which would
    // break sandboxing) since other errors would be handled by the invalid generated regex syntax
    throw new Error('Interpolation preceded by invalid incomplete token');
  }
  if (
    typeof value === 'number' &&
    (regexContext === RegexContext.ENCLOSED_U || charClassContext === CharClassContext.ENCLOSED_U)
  ) {
    return value.toString(16);
  }
  const isPattern = value instanceof Pattern;
  let escapedValue = '';
  if (!(value instanceof RegExp)) {
    value = String(value);
    if (!isPattern) {
      escapedValue = escapeV(
        value,
        regexContext === RegexContext.CHAR_CLASS ? Context.CHAR_CLASS : Context.DEFAULT
      );
    }
    // Check `escapedValue` (not just patterns) since possible breakout char `>` isn't escaped
    const breakoutChar = getBreakoutChar(escapedValue || value, regexContext, charClassContext);
    if (breakoutChar) {
      throw new Error(`Unescaped stray "${breakoutChar}" in the interpolated value would have side effects outside it`);
    }
  }

  if (
    regexContext === RegexContext.INTERVAL_QUANTIFIER ||
    regexContext === RegexContext.GROUP_NAME ||
    enclosedTokenRegexContexts.has(regexContext) ||
    enclosedTokenCharClassContexts.has(charClassContext)
  ) {
    return isPattern ? String(value) : escapedValue;
  } else if (regexContext === RegexContext.CHAR_CLASS) {
    if (isPattern) {
      if (hasUnescaped(String(value), '^-|^&&|-$|&&$')) {
        // Sandboxing so we don't change the chars outside the pattern into being part of an
        // operation they didn't initiate. Same problem as starting a pattern with a quantifier
        throw new Error('Cannot use range or set operator at boundary of interpolated pattern; move the operation into the pattern or the operator outside of it');
      }
      const sandboxedValue = sandboxLoneCharClassCaret(sandboxLoneDoublePunctuatorChar(value));
      // Atomize via nested character class `[…]` if it contains implicit or explicit union (check
      // the unadjusted value)
      return containsCharClassUnion(value) ? `[${sandboxedValue}]` : sandboxUnsafeNulls(sandboxedValue);
    }
    // Atomize via nested character class `[…]` if more than one node
    return containsCharClassUnion(escapedValue) ? `[${escapedValue}]` : escapedValue;
  }
  // `RegexContext.DEFAULT`
  if (value instanceof RegExp) {
    const transformed = transformForLocalFlags(value, flags);
    const backrefsAdjusted = adjustNumberedBackrefs(transformed.value, precedingCaptures);
    // Sandbox and atomize; if we used a pattern modifier it has the same effect
    return transformed.usedModifier ? backrefsAdjusted : `(?:${backrefsAdjusted})`;
  }
  if (isPattern) {
    // Sandbox and atomize
    return `(?:${value})`;
  }
  // Sandbox and atomize
  return wrapEscapedStr ? `(?:${escapedValue})` : escapedValue;
}

/**
@param {RegExp} re
@param {string} outerFlags
@returns {{value: string; usedModifier?: boolean;}}
*/
function transformForLocalFlags(re, outerFlags) {
  /** @type {{i: boolean | null; m: boolean | null; s: boolean | null;}} */
  const modFlagsObj = {
    i: null,
    m: null,
    s: null,
  };
  const newlines = '\\n\\r\\u2028\\u2029';
  let value = re.source;
  if (re.ignoreCase !== outerFlags.includes('i')) {
    if (patternModsSupported) {
      modFlagsObj.i = re.ignoreCase;
    } else {
      throw new Error('Pattern modifiers not supported, so flag i on the outer and interpolated regex must match');
    }
  }
  if (re.dotAll !== outerFlags.includes('s')) {
    if (patternModsSupported) {
      modFlagsObj.s = re.dotAll;
    } else {
      value = replaceUnescaped(value, '\\.', (re.dotAll ? '[^]' : `[^${newlines}]`), Context.DEFAULT);
    }
  }
  if (re.multiline !== outerFlags.includes('m')) {
    if (patternModsSupported) {
      modFlagsObj.m = re.multiline;
    } else {
      value = replaceUnescaped(value, '\\^', (re.multiline ? `(?<=^|[${newlines}])` : '(?<![^])'), Context.DEFAULT);
      value = replaceUnescaped(value, '\\$', (re.multiline ? `(?=$|[${newlines}])` : '(?![^])'), Context.DEFAULT);
    }
  }
  if (patternModsSupported) {
    const keys = Object.keys(modFlagsObj);
    let modifier = keys.filter(k => modFlagsObj[k] === true).join('');
    const modOff = keys.filter(k => modFlagsObj[k] === false).join('');
    if (modOff) {
      modifier += `-${modOff}`;
    }
    if (modifier) {
      return {
        value: `(?${modifier}:${value})`,
        usedModifier: true,
      };
    }
  }
  return {value};
}

/**
Build the capturing group map (with emulation groups marked as `false` to indicate their submatches
shouldn't appear in results), and remove the markers for anonymous captures which were added to
emulate extended syntax.
@param {string} expression
@returns {{expression: string; captureMap: Array<boolean>;}}
*/
function unmarkEmulationGroups(expression) {
  const marker = emulationGroupMarker.replace(/\$/g, '\\$');
  const captureMap = [true];
  expression = replaceUnescaped(
    expression,
    `(?:${capturingDelim})(?<mark>${marker})?`,
    ({0: m, groups: {mark}}) => {
      if (mark) {
        captureMap.push(false);
        return m.slice(0, -emulationGroupMarker.length);
      }
      captureMap.push(true);
      return m;
    },
    Context.DEFAULT
  );
  return {
    captureMap,
    expression,
  };
}

export {
  regex,
  pattern,
  rewrite,
};
