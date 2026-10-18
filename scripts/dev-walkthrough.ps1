# End-to-end walkthrough through the frontend origin (5173):
# Next route handlers (/session/*) + rewrite proxy (/api/v1/*) + real backend + embedded infra.
$ErrorActionPreference = "Continue"
$BASE = "http://localhost:5173"
$script:fails = 0
$script:passes = 0

function Check([string]$name, [bool]$condition, [string]$detail = "") {
  if ($condition) { $script:passes++; Write-Output "PASS  $name  $detail" }
  else { $script:fails++; Write-Output "FAIL  $name  $detail" }
}

function RawText($raw) {
  if ($null -eq $raw) { return "" }
  if ($raw -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($raw) }
  return [string]$raw
}

function Snip([string]$text, [int]$len = 160) {
  $t = ($text -replace "\s+", " ").Trim()
  if ($t.Length -le $len) { return $t }
  return $t.Substring(0, $len)
}

function Api([string]$method, [string]$path, [string]$token, $body = $null, [hashtable]$extra = @{}, $session = $null) {
  $headers = @{}
  if ($token) { $headers["Authorization"] = "Bearer $token" }
  foreach ($k in $extra.Keys) { $headers[$k] = $extra[$k] }
  $params = @{ Uri = "$BASE$path"; Method = $method; Headers = $headers; UseBasicParsing = $true; TimeoutSec = 90 }
  if ($body -ne $null) {
    $params.ContentType = "application/json"
    $params.Body = ($body | ConvertTo-Json -Depth 10 -Compress)
  } elseif ($method -ne "GET") {
    # PS 5.1 sends x-www-form-urlencoded on bodyless POSTs, which Fastify rejects; send {}.
    $params.ContentType = "application/json"
    $params.Body = "{}"
  }
  if ($session) { $params.WebSession = $session }
  try {
    $r = Invoke-WebRequest @params
    $text = RawText $r.Content
    $json = $null; try { $json = $text | ConvertFrom-Json } catch {}
    return @{ ok = $true; status = [int]$r.StatusCode; json = $json; raw = $text; headers = $r.Headers }
  } catch {
    $text = ""
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $text = [string]$_.ErrorDetails.Message }
    if (-not $text) {
      $resp = $_.Exception.Response
      if ($resp) { try { $reader = New-Object System.IO.StreamReader($resp.GetResponseStream()); $text = $reader.ReadToEnd() } catch {} }
    }
    if (-not $text) { $text = $_.Exception.Message }
    $json = $null; try { $json = $text | ConvertFrom-Json } catch {}
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    return @{ ok = $false; status = $status; json = $json; raw = $text; headers = @{} }
  }
}

function Totp([string]$secret) {
  if (-not $secret) { return "" }
  return (node scripts\dev-totp.mjs $secret | Select-Object -Last 1).Trim()
}

function GetRt($session) {
  if ($null -eq $session) { return $null }
  try {
    foreach ($c in $session.Cookies.GetCookies([System.Uri]"$BASE/session/")) {
      if ($c.Name -eq "sp_rt") { return $c }
    }
  } catch {}
  return $null
}

Write-Output "== A. sign-in page + login + session custody =="
$page = Api "GET" "/sign-in" $null
Check "GET /sign-in 200" ($page.status -eq 200) "status=$($page.status)"
Check "sign-in HTML has wordmark" ($page.raw -match "SchoolLedger")

$ws = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$login = Api "POST" "/session/login" $null @{ email = "alice.santos@student.portal.test"; password = "Password123!" } @{} $ws
Check "POST /session/login 200" ($login.ok -and $login.status -eq 200) "status=$($login.status) code=$($login.json.code)"
$token = $login.json.accessToken
Check "access token returned" ([bool]$token)
Check "refresh token NOT in body (cookie custody)" ($null -eq $login.json.refreshToken)

$rtCookie = GetRt $ws
Check "sp_rt cookie set + HttpOnly" ($null -ne $rtCookie -and $rtCookie.HttpOnly) "valueLen=$($rtCookie.Value.Length)"

$me = Api "GET" "/api/v1/auth/me" $token
Check "GET /auth/me 200" ($me.status -eq 200) "status=$($me.status)"
Check "me email matches" ($me.json.email -eq "alice.santos@student.portal.test")
Check "me has student profile" ($null -ne $me.json.profile.studentNo) "studentNo=$($me.json.profile.studentNo)"
$studentId = $me.json.id

Write-Output "== B. web pages render (SSR through the shell) =="
foreach ($path in @("/", "/enroll", "/schedule", "/grades", "/assessment", "/documents", "/holds", "/account")) {
  $p = Api "GET" $path $null $null @{} $ws
  Check "GET $path 200" ($p.status -eq 200) "status=$($p.status)"
}
$homePage = Api "GET" "/" $null $null @{} $ws
Check "home HTML has wordmark" ($homePage.raw -match "SchoolLedger")
$enrollPage = Api "GET" "/enroll" $null $null @{} $ws
Check "app shell SSR'd on /enroll (page content is client-gated)" ($enrollPage.raw -match "SchoolLedger")

Write-Output "== C. catalog context =="
$terms = Api "GET" "/api/v1/academics/terms" $token
Check "GET terms 200" ($terms.status -eq 200)
$term = $terms.json | Where-Object { $_.status -eq "ENROLLMENT" } | Select-Object -First 1
if (-not $term) { $term = $terms.json | Sort-Object startsAt -Descending | Select-Object -First 1 }
Check "found an ENROLLMENT term" ($null -ne $term) "term=$($term.code) status=$($term.status)"

$elig = Api "GET" "/api/v1/enrollments/eligibility?termId=$($term.id)" $token
Check "GET eligibility 200" ($elig.status -eq 200) "eligible=$($elig.json.eligible.Count) blocked=$($elig.json.blocked.Count)"

$pre = Api "GET" "/api/v1/enrollments?termId=$($term.id)" $token
Check "GET enrollment before reserving -> 404" ($pre.status -eq 404) "status=$($pre.status)"

$sections = Api "GET" "/api/v1/academics/terms/$($term.id)/sections" $token
Check "GET sections 200" ($sections.status -eq 200) "count=$($sections.json.Count)"
$s102 = $sections.json | Where-Object { $_.course.code -eq "CS102" } | Select-Object -First 1
$s103 = $sections.json | Where-Object { $_.course.code -eq "CS103" } | Select-Object -First 1
$s101 = $sections.json | Where-Object { $_.course.code -eq "GE101" } | Select-Object -First 1
Check "seed sections present (CS102/CS103/GE101)" ($null -ne $s102 -and $null -ne $s103 -and $null -ne $s101)

Write-Output "== D. reserve (batch, idempotent) =="
$key1 = [guid]::NewGuid().ToString()
$body1 = @{ termId = $term.id; sectionIds = @($s102.id, $s101.id) }
$r1 = Api "POST" "/api/v1/enrollments/reserve" $token $body1 @{ "idempotency-key" = $key1 }
Check "reserve batch -> 201" ($r1.status -eq 201) "status=$($r1.status) code=$($r1.json.code)"
Check "reserve returned 2 items" ($r1.json.items.Count -eq 2)
Check "reserve returned assessment" ($null -ne $r1.json.assessment) "total=$($r1.json.assessment.totalAmount)"
$enrId = $r1.json.enrollment.id
Check "enrollment returned (no prior doc chain)" ([bool]$enrId)

$r1b = Api "POST" "/api/v1/enrollments/reserve" $token $body1 @{ "idempotency-key" = $key1 }
Check "idempotent replay -> 201 same enrollment" ($r1b.status -eq 201 -and $r1b.json.enrollment.id -eq $enrId)

$key2 = [guid]::NewGuid().ToString()
$r2 = Api "POST" "/api/v1/enrollments/reserve" $token @{ termId = $term.id; sectionIds = @($s103.id) } @{ "idempotency-key" = $key2 }
Check "CS103 not silently enrolled (blocked)" (-not $r2.ok) "status=$($r2.status) code=$($r2.json.code) body=$(Snip $r2.raw)"

$enr = Api "GET" "/api/v1/enrollments?termId=$($term.id)" $token
$enrolledNow = ($enr.json.items | Where-Object { $_.status -eq "ENROLLED" }).Count
Check "GET enrollment 200" ($enr.status -eq 200) "enrolledItems=$enrolledNow"

Write-Output "== E. assessment =="
$asmt = Api "GET" "/api/v1/enrollments/$enrId/assessment" $token
Check "GET assessment 200" ($asmt.status -eq 200) "status=$($asmt.status)"
Check "breakdown has line items" ($asmt.json.breakdown.lineItems.Count -gt 0) "lines=$($asmt.json.breakdown.lineItems.Count) total=$($asmt.json.totalAmount)"
Check "total is nonzero" ($asmt.json.totalAmount -ne "0.00") "total=$($asmt.json.totalAmount)"

Write-Output "== F. drop + re-reserve =="
$geItem = $enr.json.items | Where-Object { $_.section.course.code -eq "GE101" } | Select-Object -First 1
Check "found GE101 item" ($null -ne $geItem) "itemId=$($geItem.id)"
$d = Api "POST" "/api/v1/enrollments/drop" $token @{ itemId = $geItem.id }
Check "drop item -> 200" ($d.status -eq 200) "status=$($d.status) code=$($d.json.code)"
Check "dropped item status DROPPED" ($d.json.item.status -eq "DROPPED")
Check "drop reports promoted=false (nobody waited)" ($d.json.promoted -eq $false)

$enr2 = Api "GET" "/api/v1/enrollments?termId=$($term.id)" $token
$enr2Groups = ($enr2.json.items | Group-Object status | ForEach-Object { "$($_.Name):$($_.Count)" }) -join " "
$enr2Enrolled = @($enr2.json.items | Where-Object { $_.status -eq "ENROLLED" }).Count
Check "after drop: 1 ENROLLED" ($enr2Enrolled -eq 1) "enrolled=$enr2Enrolled items=$($enr2.json.items.Count) [$enr2Groups]"

$key3 = [guid]::NewGuid().ToString()
$r3 = Api "POST" "/api/v1/enrollments/reserve" $token @{ termId = $term.id; sectionIds = @($s101.id) } @{ "idempotency-key" = $key3 }
Check "re-reserve GE101 -> 201" ($r3.status -eq 201) "status=$($r3.status) code=$($r3.json.code)"
$enr3 = Api "GET" "/api/v1/enrollments?termId=$($term.id)" $token
$enr3Enrolled = @($enr3.json.items | Where-Object { $_.status -eq "ENROLLED" }).Count
Check "after re-reserve: 2 ENROLLED" ($enr3Enrolled -eq 2) "enrolled=$enr3Enrolled"

Write-Output "== G. waitlist on an open section is rejected =="
$wl = Api "POST" "/api/v1/enrollments/waitlist" $token @{ termId = $term.id; sectionId = $s101.id }
Check "waitlist on open section -> error" (-not $wl.ok) "status=$($wl.status) code=$($wl.json.code) body=$(Snip $wl.raw)"

Write-Output "== H. grades + holds =="
$ledger = Api "GET" "/api/v1/grading/students/$studentId/ledger" $token
Check "GET ledger 200" ($ledger.status -eq 200) "entries=$($ledger.json.Count)"
$gwaresp = Api "GET" "/api/v1/grading/students/$studentId/gwa" $token
Check "GET gwa 200" ($gwaresp.status -eq 200) "standing=$($gwaresp.json.standing) cumulative=$($gwaresp.json.cumulativeGwa)"
$holds = Api "GET" "/api/v1/iam/students/$studentId/holds?includeLifted=true" $token
Check "GET holds 200" ($holds.status -eq 200) "holds=$($holds.json.Count)"

Write-Output "== I. documents: COR full cycle + idempotent replay =="
$dkey = [guid]::NewGuid().ToString()
$doc = Api "POST" "/api/v1/documents/requests" $token @{ type = "COR"; termId = $term.id } @{ "idempotency-key" = $dkey }
Check "request COR -> 201" ($doc.status -eq 201) "status=$($doc.status) docStatus=$($doc.json.status) code=$($doc.json.code)"
$docId = $doc.json.id
$docReplay = Api "POST" "/api/v1/documents/requests" $token @{ type = "COR"; termId = $term.id } @{ "idempotency-key" = $dkey }
Check "document idempotent replay -> same id" ($docReplay.json.id -eq $docId) "status=$($docReplay.status)"

$final = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  $final = Api "GET" "/api/v1/documents/requests/$docId" $token
  if ($final.json.status -eq "READY" -or $final.json.status -eq "FAILED") { break }
}
Check "COR reaches READY" ($final.json.status -eq "READY") "status=$($final.json.status) reason=$($final.json.failureReason) polls=$i"
Check "serial assigned" ([bool]$final.json.serialNo) "serialNo=$($final.json.serialNo)"

$dl = Api "GET" "/api/v1/documents/requests/$docId/download" $token
Check "download url issued" ($dl.status -eq 200 -and [bool]$dl.json.url) "status=$($dl.status) code=$($dl.json.code)"
if ($dl.json.url) {
  try {
    $file = Invoke-WebRequest -Uri $dl.json.url -UseBasicParsing -TimeoutSec 30
    Check "downloaded file bytes" ($file.RawContentLength -gt 0) "bytes=$($file.RawContentLength) type=$($file.Headers['Content-Type'])"
  } catch { Check "downloaded file bytes" $false $_.Exception.Message }
}
$verify = Api "GET" "/api/v1/public/verify/$($final.json.serialHash)" $null
Check "public verify 200 valid" ($verify.status -eq 200 -and $verify.json.valid -eq $true) "masked=$($verify.json.studentNoMasked) type=$($verify.json.documentType)"

Write-Output "== J. official transcript is registrar-only =="
$okey = [guid]::NewGuid().ToString()
$official = Api "POST" "/api/v1/documents/requests" $token @{ type = "TOR_OFFICIAL" } @{ "idempotency-key" = $okey }
Check "student TOR_OFFICIAL -> 403 FORBIDDEN" ($official.status -eq 403 -and $official.json.code -eq "FORBIDDEN") "status=$($official.status) code=$($official.json.code) body=$(Snip $official.raw)"

Write-Output "== K. TOTP enrollment + step-up + official (student-requestable) doc =="
$setup = Api "POST" "/api/v1/auth/totp/setup" $token
Check "totp setup 200" ($setup.status -eq 200) "status=$($setup.status) code=$($setup.json.code)"
$secret = $setup.json.secret
Check "secret returned" ([bool]$secret)
$enable = Api "POST" "/api/v1/auth/totp/enable" $token @{ code = (Totp $secret) }
if ($enable.status -ne 204) { Start-Sleep -Seconds 2; $enable = Api "POST" "/api/v1/auth/totp/enable" $token @{ code = (Totp $secret) } }
Check "totp enable -> 204" ($enable.status -eq 204) "status=$($enable.status) body=$(Snip $enable.raw)"
$me2 = Api "GET" "/api/v1/auth/me" $token
Check "me shows mfaEnabled" ($me2.json.mfaEnabled -eq $true)

$step = Api "POST" "/api/v1/auth/step-up" $token @{ code = (Totp $secret) }
if ($step.status -ge 400) { Start-Sleep -Seconds 2; $step = Api "POST" "/api/v1/auth/step-up" $token @{ code = (Totp $secret) } }
Check "step-up accepted" ($step.status -eq 200 -or $step.status -eq 204) "status=$($step.status) code=$($step.json.code)"
$elevatedToken = $step.json.accessToken
Check "step-up returns ELEVATED access token (new)" ([bool]$elevatedToken -and $elevatedToken -ne $token)
if ($elevatedToken) { $token = $elevatedToken }

$torElevated = Api "POST" "/api/v1/documents/requests" $token @{ type = "TOR_OFFICIAL" } @{ "idempotency-key" = [guid]::NewGuid().ToString() }
Check "TOR_OFFICIAL still 403 with elevation (role wins)" ($torElevated.status -eq 403 -and $torElevated.json.code -eq "FORBIDDEN") "status=$($torElevated.status) code=$($torElevated.json.code)"

$ckey = [guid]::NewGuid().ToString()
$cert = Api "POST" "/api/v1/documents/requests" $token @{ type = "CERT_GRADES"; termId = $term.id } @{ "idempotency-key" = $ckey }
Check "CERT_GRADES request -> 201" ($cert.status -eq 201) "status=$($cert.status) code=$($cert.json.code) body=$(Snip $cert.raw)"
$certId = $cert.json.id
$cfinal = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  $cfinal = Api "GET" "/api/v1/documents/requests/$certId" $token
  if ($cfinal.json.status -eq "READY" -or $cfinal.json.status -eq "FAILED") { break }
}
Check "CERT_GRADES reaches READY" ($cfinal.json.status -eq "READY") "status=$($cfinal.json.status) polls=$i"
$cdl = Api "GET" "/api/v1/documents/requests/$certId/download" $token
Check "CERT_GRADES download url issued" ($cdl.status -eq 200 -and [bool]$cdl.json.url) "status=$($cdl.status) code=$($cdl.json.code)"
if ($cdl.json.url) {
  try {
    $cfile = Invoke-WebRequest -Uri $cdl.json.url -UseBasicParsing -TimeoutSec 30
    Check "CERT_GRADES file bytes" ($cfile.RawContentLength -gt 0) "bytes=$($cfile.RawContentLength)"
  } catch { Check "CERT_GRADES file bytes" $false $_.Exception.Message }
}

Write-Output "== L. clearance hold gates official download (BSL-007) =="
$loginC = Api "POST" "/session/login" $null @{ email = "cashier@portal.test"; password = "Password123!" }
Check "cashier login 200" ($loginC.status -eq 200) "status=$($loginC.status)"
$tokenC = $loginC.json.accessToken
$hold = Api "POST" "/api/v1/iam/students/$studentId/holds" $tokenC @{ type = "FINANCIAL"; reason = "Outstanding balance (walkthrough)" }
Check "cashier places FINANCIAL hold -> 201" ($hold.status -eq 201) "status=$($hold.status) code=$($hold.json.code) body=$(Snip $hold.raw)"
$holdId = $hold.json.id

$blockedDl = Api "GET" "/api/v1/documents/requests/$certId/download" $token
Check "official download blocked by hold -> 422 STUDENT_CLEARANCE_HOLD" ($blockedDl.status -eq 422 -and $blockedDl.json.code -eq "STUDENT_CLEARANCE_HOLD") "status=$($blockedDl.status) code=$($blockedDl.json.code)"

$holdsNow = Api "GET" "/api/v1/iam/students/$studentId/holds" $token
$activeHold = @($holdsNow.json | Where-Object { $_.id -eq $holdId -and $null -eq $_.liftedAt }).Count
Check "student sees the active hold" ($activeHold -eq 1) "count=$($holdsNow.json.Count)"

$lift = Api "POST" "/api/v1/iam/holds/$holdId/lift" $tokenC
Check "cashier lifts hold -> 200" ($lift.status -eq 200) "status=$($lift.status) code=$($lift.json.code)"

$afterLift = Api "GET" "/api/v1/documents/requests/$certId/download" $token
Check "official download works after lift" ($afterLift.status -eq 200 -and [bool]$afterLift.json.url) "status=$($afterLift.status) code=$($afterLift.json.code)"

Write-Output "== M. refresh rotation + reuse detection (through /session/refresh) =="
$oldRtCookie = GetRt $ws
$oldRt = $oldRtCookie.Value
Check "captured current sp_rt" ([bool]$oldRt) "len=$($oldRt.Length)"
$refresh1 = Api "POST" "/session/refresh" $null $null @{} $ws
Check "refresh #1 -> 200" ($refresh1.status -eq 200) "status=$($refresh1.status) code=$($refresh1.json.code)"
Check "rotated access token" ([bool]$refresh1.json.accessToken)
$newRt = (GetRt $ws).Value
Check "refresh cookie rotated" ($newRt -ne $oldRt -and [bool]$newRt) "len=$($newRt.Length)"

# PS 5.1 Invoke-WebRequest drops manually-set Cookie headers; curl sends them properly.
$reuseOut = @(& curl.exe -s -w "`n%{http_code}" -X POST -H "Content-Type: application/json" -H "Cookie: sp_rt=$oldRt" -d "{}" "$BASE/session/refresh")
$reuseCode = $null; $reuseStatus = 0; $reuseRaw = ""
if ($reuseOut.Count -ge 2) {
  $reuseStatus = [int]$reuseOut[-1]
  $reuseRaw = ($reuseOut[0..($reuseOut.Count - 2)]) -join "`n"
}
try { $reuseCode = ($reuseRaw | ConvertFrom-Json).code } catch {}
Check "OLD refresh replay -> 401 REFRESH_TOKEN_REUSED" ($reuseStatus -eq 401 -and $reuseCode -eq "REFRESH_TOKEN_REUSED") "status=$reuseStatus code=$reuseCode body=$(Snip $reuseRaw)"

$after = Api "POST" "/session/refresh" $null $null @{} $ws
Check "family revoked: current cookie rejected too" ($after.status -eq 401) "status=$($after.status) code=$($after.json.code)"

Write-Output "== N. re-login (MFA now required) + logout =="
$login2 = Api "POST" "/session/login" $null @{ email = "alice.santos@student.portal.test"; password = "Password123!" } @{} $ws
Check "re-login 200" ($login2.status -eq 200) "status=$($login2.status)"
Check "re-login now demands MFA (TOTP enrolled)" ($login2.json.mfaRequired -eq $true) "mfaRequired=$($login2.json.mfaRequired)"
$mfa = $null
for ($attempt = 0; $attempt -lt 2; $attempt++) {
  $mfa = Api "POST" "/session/mfa" $null @{ mfaToken = $login2.json.mfaToken; code = (Totp $secret) } @{} $ws
  if ($mfa.status -eq 200) { break }
  Start-Sleep -Seconds 31
}
Check "MFA login -> 200 tokens" ($mfa.status -eq 200) "status=$($mfa.status) code=$($mfa.json.code) body=$(Snip $mfa.raw)"
$token3 = $mfa.json.accessToken
Check "refresh token again cookie-only" ($null -eq $mfa.json.refreshToken)
$me3 = Api "GET" "/api/v1/auth/me" $token3
Check "me works after MFA login" ($me3.status -eq 200) "status=$($me3.status) code=$($me3.json.code)"

$logout = Api "POST" "/session/logout" $null $null @{} $ws
Check "logout -> 204" ($logout.status -eq 204) "status=$($logout.status)"
$afterLogout = Api "POST" "/session/refresh" $null $null @{} $ws
Check "refresh after logout -> 401" ($afterLogout.status -eq 401) "status=$($afterLogout.status)"

Write-Output ""
Write-Output "===== RESULT: $script:passes passed, $script:fails failed ====="
exit $script:fails
