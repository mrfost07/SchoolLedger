-- release_slots.lua — rollback / drop compensation for reserve_slots.lua
--
-- KEYS[1]   = student schedule registry SET
-- KEYS[2..] = per-section remaining-slot counters
-- ARGV[1]   = payload (same encoding as reserve_slots.lua)
--
-- Increments every counter and removes the student's interval registrations
-- for the given sections. Best-effort: counter drift self-heals whenever the
-- authoritative DB state is re-synced (see capacity.ts syncSection).

local studentKey = KEYS[1]
local payload = ARGV[1]
local released = 0

for sec in string.gmatch(payload, "[^|]+") do
  local id, ivs = string.match(sec, "^([^@]+)@(.+)$")
  if id then
    released = released + 1
    for ivsEncoded in string.gmatch(ivs, "[^;]+") do
      local d, s, e = string.match(ivsEncoded, "^(%d+):(%d+):(%d+)$")
      if d then
        redis.call("SREM", studentKey, d .. "|" .. s .. "|" .. e .. "|" .. id)
      end
    end
  end
end

for i = 2, #KEYS do
  redis.call("INCR", KEYS[i])
end

return "RELEASED:" .. released
