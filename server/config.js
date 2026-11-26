// Single source of truth for auction configuration rules.
// Used by BOTH room creation (RoomManager.createRoom / POST /api/rooms)
// and lobby updates (RoomManager.updateConfig / update_config).
//
// Purse, minimum squad size, minimum keepers and 15s bid timer are FIXED IPL rules (FIXED_RULES).
// Room creator / host-adjustable at room creation: total squad size (maxSquadSize) & overseas player limit (maxOverseas),
// plus delay between lots, minimum participants, floor price.
// Settings with no UI control (minParticipants, minPlayerPrice, autoAdvanceDelay, minWKs)
// keep their defaults unless set at creation, and are still range-checked.

// Approved defaults (16 Nov 2026): ₹120 Cr flat purse, squad 15–25, 8 overseas, 15 s timer.
export const SQUAD_SIZE_OPTIONS = Object.freeze([15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
export const OVERSEAS_LIMIT_OPTIONS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8]);

export const DEFAULT_CONFIG = Object.freeze({
  basePurse: 120.0,
  maxFranchises: 10,
  minParticipants: 2,
  minSquadSize: 15,
  maxSquadSize: 25,
  maxOverseas: 8,
  minWKs: 1,
  minPlayerPrice: 0.20, // ₹ Cr floor used for the squad-completion reserve
  timerDuration: 15, // seconds
  autoAdvanceDelay: 4 // seconds between lots
});

// kind: 'int' = whole number; 'money' = ₹ Cr with at most 2 decimals; 'number' = finite number
export const CONFIG_RULES = Object.freeze({
  basePurse:        { kind: 'money',  min: 20,  max: 250, label: 'Base purse (₹ Cr)' },
  minParticipants:  { kind: 'int',    min: 1,   max: 10,  label: 'Minimum participants' },
  minSquadSize:     { kind: 'int',    min: 5,   max: 25,  label: 'Minimum squad size' },
  maxSquadSize:     { kind: 'int',    min: 15,  max: 25,  label: 'Maximum squad players' },
  maxOverseas:      { kind: 'int',    min: 0,   max: 8,   label: 'Maximum overseas players' },
  minWKs:           { kind: 'int',    min: 0,   max: 3,   label: 'Minimum wicketkeepers' },
  minPlayerPrice:   { kind: 'money',  min: 0.1, max: 2,   label: 'Minimum player price (₹ Cr)' },
  timerDuration:    { kind: 'int',    min: 10,  max: 90,  label: 'Bid timer (seconds)' },
  autoAdvanceDelay: { kind: 'number', min: 1,   max: 30,  label: 'Delay between lots (seconds)' }
});

// Fixed by the game itself (10 IPL franchises); never client-settable
const IMMUTABLE_KEYS = ['maxFranchises'];

// IPL auction rules: fixed for every new room. Sending the same value is accepted (older
// clients send them); any other value is rejected. maxSquadSize and maxOverseas are
// customizable by the room creator (within CONFIG_RULES and maxOverseas <= maxSquadSize).
export const FIXED_RULES = Object.freeze({ basePurse: 120, minSquadSize: 15, minWKs: 1, timerDuration: 15 });

const CONFIG_KEY_ALIASES = Object.freeze({
  max_squad_size: 'maxSquadSize',
  max_overseas_players: 'maxOverseas'
});

/**
 * Resolve effective squad and overseas limits for any room or config object.
 * Provides sensible fallback defaults for legacy rooms (15 total players, 8 overseas).
 */
export function getRoomSquadLimits(roomOrConfig) {
  const isRoom = roomOrConfig && typeof roomOrConfig === 'object' && ('config' in roomOrConfig || 'max_squad_size' in roomOrConfig || 'franchises' in roomOrConfig);
  const cfg = isRoom ? (roomOrConfig.config || {}) : (roomOrConfig || {});
  const rawMaxSquad = cfg.maxSquadSize ?? cfg.max_squad_size ?? roomOrConfig?.max_squad_size;
  const rawMaxOverseas = cfg.maxOverseas ?? cfg.max_overseas_players ?? roomOrConfig?.max_overseas_players;
  const maxSquadSize = Number.isInteger(Number(rawMaxSquad)) && Number(rawMaxSquad) > 0 ? Number(rawMaxSquad) : 15;
  const maxOverseas = Number.isInteger(Number(rawMaxOverseas)) && Number(rawMaxOverseas) >= 0 ? Number(rawMaxOverseas) : 8;
  const minSquadSize = Number.isInteger(Number(cfg.minSquadSize)) && Number(cfg.minSquadSize) > 0
    ? Math.min(Number(cfg.minSquadSize), maxSquadSize)
    : Math.min(15, maxSquadSize);
  return { minSquadSize, maxSquadSize, maxOverseas };
}

/**
 * Compute live squad composition & remaining slot breakdown for a franchise.
 */
export function getFranchiseSlotStats(franchise, roomOrConfig) {
  const { maxSquadSize, maxOverseas } = getRoomSquadLimits(roomOrConfig);
  const squad = Array.isArray(franchise?.squad) ? franchise.squad : [];
  const squadCount = squad.length;
  const overseasCount = Number.isFinite(franchise?.overseasCount)
    ? franchise.overseasCount
    : squad.filter(p => p?.isOverseas === true).length;
  const indianCount = Math.max(0, squadCount - overseasCount);
  const totalRemainingSlots = Math.max(0, maxSquadSize - squadCount);
  const remainingOverseasSlots = Math.min(totalRemainingSlots, Math.max(0, maxOverseas - overseasCount));
  const remainingIndianSlots = totalRemainingSlots;
  return {
    maxSquadSize,
    maxOverseas,
    squadCount,
    overseasCount,
    indianCount,
    totalRemainingSlots,
    remainingOverseasSlots,
    remainingIndianSlots,
    isSquadFull: squadCount >= maxSquadSize,
    isOverseasFull: overseasCount >= maxOverseas
  };
}

function checkValue(key, raw) {
  const rule = CONFIG_RULES[key];
  // Accept numbers, and numeric strings from HTML inputs; reject everything else
  if (typeof raw === 'string' && raw.trim() === '') return { error: `${rule.label} is required` };
  if (typeof raw !== 'number' && typeof raw !== 'string') return { error: `${rule.label} must be a number` };
  const v = Number(raw);
  if (!Number.isFinite(v)) return { error: `${rule.label} must be a number` };
  if (rule.kind === 'int' && !Number.isInteger(v)) return { error: `${rule.label} must be a whole number` };
  if (rule.kind === 'money' && Math.abs(Math.round(v * 100) - v * 100) > 1e-9) {
    return { error: `${rule.label} can have at most 2 decimal places` };
  }
  if (v < rule.min || v > rule.max) return { error: `${rule.label} must be between ${rule.min} and ${rule.max}` };
  return { value: v };
}

function checkCombination(c) {
  const errors = [];
  if (c.minSquadSize > c.maxSquadSize) {
    errors.push(`Minimum squad size (${c.minSquadSize}) cannot exceed maximum squad size (${c.maxSquadSize})`);
  }
  if (c.maxOverseas > c.maxSquadSize) {
    errors.push(`Maximum overseas players (${c.maxOverseas}) cannot exceed maximum squad size (${c.maxSquadSize})`);
  }
  if (c.minWKs > c.minSquadSize) {
    errors.push(`Minimum wicketkeepers (${c.minWKs}) cannot exceed minimum squad size (${c.minSquadSize})`);
  }
  if (c.minParticipants > c.maxFranchises) {
    errors.push(`Minimum participants (${c.minParticipants}) cannot exceed ${c.maxFranchises} franchises`);
  }
  // Every franchise must be able to afford a minimum squad at the floor price
  const minimumSquadCost = Math.round(c.minSquadSize * c.minPlayerPrice * 100) / 100;
  if (minimumSquadCost > c.basePurse) {
    errors.push(`Base purse ₹${c.basePurse} Cr cannot cover a minimum squad of ${c.minSquadSize} at ₹${c.minPlayerPrice} Cr each (₹${minimumSquadCost} Cr)`);
  }
  return errors;
}

/**
 * Validate a partial config change against a base config.
 * Returns { ok: true, config } with the merged, normalised config, or
 * { ok: false, errors: [...] }. Nothing is ever silently dropped or clamped:
 * unknown keys, bad types, out-of-range values and invalid combinations are errors.
 */
export function validateConfig(changes, base = DEFAULT_CONFIG) {
  if (changes === undefined || changes === null) changes = {};
  if (typeof changes !== 'object' || Array.isArray(changes)) {
    return { ok: false, errors: ['Configuration must be an object'] };
  }
  const errors = [];
  const merged = { ...DEFAULT_CONFIG, ...base };
  const normalizedChanges = {};

  for (const [rawKey, raw] of Object.entries(changes)) {
    if (raw === undefined) continue;
    const key = CONFIG_KEY_ALIASES[rawKey] || rawKey;
    if (key in normalizedChanges && Number(normalizedChanges[key]) !== Number(raw)) {
      errors.push(`Conflicting values provided for ${CONFIG_RULES[key]?.label || key}`);
      continue;
    }
    normalizedChanges[key] = raw;
  }

  for (const [key, raw] of Object.entries(normalizedChanges)) {
    if (IMMUTABLE_KEYS.includes(key)) {
      if (Number(raw) !== merged[key]) errors.push(`${key} cannot be changed`);
      continue;
    }
    if (!CONFIG_RULES[key]) {
      errors.push(`Unknown setting: ${key}`);
      continue;
    }
    const r = checkValue(key, raw);
    if (r.error) errors.push(r.error);
    else if (key in FIXED_RULES && r.value !== FIXED_RULES[key]) errors.push(`${CONFIG_RULES[key].label} is fixed at ${FIXED_RULES[key]} by the IPL auction rules`);
    else merged[key] = r.value;
  }

  if (errors.length === 0) errors.push(...checkCombination(merged));
  return errors.length ? { ok: false, errors } : { ok: true, config: merged };
}

export class ConfigValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.name = 'ConfigValidationError';
    this.errors = errors;
  }
}

// Fail fast if the shipped defaults ever drift outside the rules
const selfCheck = validateConfig({}, DEFAULT_CONFIG);
if (!selfCheck.ok) throw new Error(`DEFAULT_CONFIG is invalid: ${selfCheck.errors.join('; ')}`);
