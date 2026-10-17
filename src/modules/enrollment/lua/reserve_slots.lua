-- reserve_slots.lua — atomic multi-section slot reservation (BSL-202 / INV-1, INV-7)
--
-- KEYS[1]              = student schedule registry SET   (stu:{termId}:{studentId}:sched)
-- KEYS[2..N+1]         = per-section remaining-slot counters (sec:{termId}:{sectionId}:slots)
--
-- ARGV[1]              = TTL seconds for the student schedule registry
-- ARGV[2]              = payload: "id1@d:s:e;d:s:e|id2@d:s:e"  (day:startMin:endMin)
--
-- All-or-nothing: verifies capacity for every requested section, checks the
-- requesting student's existing schedule (covering concurrent requests, since
-- Lua executes atomically) and intra-batch overlaps, then decrements counters
-- and registers intervals. Any failure returns a diagnostic without mutating
-- state:
--   OK
--   BAD_PAYLOAD
--   MISSING_SLOTS:<sectionId>          (counter not initialized — caller falls back to DB)
--   SECTION_FULL:<sectionId>
--   STUDENT_CONFLICT:<sectionId>:<day>|<start>|<end>|<existingSectionId>
--   BATCH_CONFLICT:<sectionIdA>:<sectionIdB>

local studentKey = KEYS[1]
local ttl = tonumber(ARGV[1])
local payload = ARGV[2]

local function overlaps(a, b)
  return a[1] == b[1] and a[2] < b[3] and b[2] < a[3]
end

local sections = {}
for sec in string.gmatch(payload, "[^|]+") do
  local id, ivs = string.match(sec, "^([^@]+)@(.+)$")
  if not id then
    return "BAD_PAYLOAD"
  end
  local intervals = {}
  for ivsEncoded in string.gmatch(ivs, "[^;]+") do
    local d, s, e = string.match(ivsEncoded, "^(%d+):(%d+):(%d+)$")
    if not d then
      return "BAD_PAYLOAD"
    end
    intervals[#intervals + 1] = { tonumber(d), tonumber(s), tonumber(e) }
  end
  sections[#sections + 1] = { id = id, intervals = intervals }
end

if #sections == 0 or #KEYS ~= (#sections + 1) then
  return "BAD_PAYLOAD"
end

-- 1) capacity check (no mutation yet)
for i, sec in ipairs(sections) do
  local slotsKey = KEYS[i + 1]
  local value = redis.call("GET", slotsKey)
  if not value then
    return "MISSING_SLOTS:" .. sec.id
  end
  if tonumber(value) <= 0 then
    return "SECTION_FULL:" .. sec.id
  end
end

-- 2) schedule overlap against the student's registered intervals
local existing = redis.call("SMEMBERS", studentKey)
for i, sec in ipairs(sections) do
  for _, iv in ipairs(sec.intervals) do
    for _, member in ipairs(existing) do
      local d, s, e, sid = string.match(member, "^(%d+)|(%d+)|(%d+)|(.+)$")
      if d then
        if overlaps(iv, { tonumber(d), tonumber(s), tonumber(e) }) then
          return "STUDENT_CONFLICT:" .. sec.id .. ":" .. member
        end
      end
    end
  end
end

-- 3) intra-batch overlap (two requested sections clashing with each other)
for i = 1, #sections do
  for j = i + 1, #sections do
    for _, a in ipairs(sections[i].intervals) do
      for _, b in ipairs(sections[j].intervals) do
        if overlaps(a, b) then
          return "BATCH_CONFLICT:" .. sections[i].id .. ":" .. sections[j].id
        end
      end
    end
  end
end

-- 4) atomic commit: decrement every counter, register every interval
for i, sec in ipairs(sections) do
  redis.call("DECR", KEYS[i + 1])
  for _, iv in ipairs(sec.intervals) do
    redis.call("SADD", studentKey, iv[1] .. "|" .. iv[2] .. "|" .. iv[3] .. "|" .. sec.id)
  end
end
if ttl and ttl > 0 then
  redis.call("EXPIRE", studentKey, ttl)
end
return "OK"
