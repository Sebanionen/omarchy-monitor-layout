// Monitor helpers for the display-layout panel. Pure functions only:
// parsing `hyprctl monitors -j`, canvas geometry, edge snapping, overlap
// resolution, arrangement presets, and Hyprland Lua config generation.

function toArray(val) {
  if (!val) return []
  if (Array.isArray(val)) return val.slice(0)
  // Handle QQmlListModel or similar array-like objects
  var out = []
  for (var i = 0; i < val.length; i++) out.push(val[i])
  return out
}

function clone(monitor) {
  return {
    name: monitor.name,
    description: monitor.description,
    x: monitor.x,
    y: monitor.y,
    mode: monitor.mode,
    scale: monitor.scale,
    transform: monitor.transform,
    logicalW: monitor.logicalW,
    logicalH: monitor.logicalH,
    disabled: monitor.disabled,
    focused: monitor.focused,
    availableModes: toArray(monitor.availableModes)
  }
}

function normalizeMode(mode) {
  var s = String(mode === null || mode === undefined ? "" : mode).trim()
  return s.replace(/Hz$/i, "")
}

// The exact mode currently applied, matched against availableModes. Falls
// back to the first advertised mode, then "preferred".
function currentMode(m) {
  var w = Number(m.width) || 0
  var h = Number(m.height) || 0
  var rate = Number(m.refreshRate) || 0
  var exact = w + "x" + h + "@" + rate
  var modes = Array.isArray(m.availableModes) ? m.availableModes.map(normalizeMode) : []
  if (modes.indexOf(exact) >= 0) return exact
  if (modes.length > 0) return modes[0]
  return "preferred"
}

function parse(raw) {
  var list = []
  try {
    list = JSON.parse(String(raw || "[]"))
  } catch (e) {
    list = []
  }
  if (!Array.isArray(list)) list = []

  var out = []
  for (var i = 0; i < list.length; i++) {
    var m = list[i] || {}
    var scale = Number(m.scale) || 1
    if (scale <= 0) scale = 1
    var transform = Number(m.transform) || 0
    while (transform < 0) transform += 4
    transform = transform % 4

    var logicalW = Math.max(1, (Number(m.width) || 0) / scale)
    var logicalH = Math.max(1, (Number(m.height) || 0) / scale)
    // A rotated monitor reports its un-rotated resolution; swap to match
    // what the canvas should draw.
    if (transform % 2 === 1) {
      var tmp = logicalW
      logicalW = logicalH
      logicalH = tmp
    }
    logicalW = Math.round(logicalW)
    logicalH = Math.round(logicalH)

    var modes = (Array.isArray(m.availableModes) ? m.availableModes : [])
      .map(normalizeMode)
      .filter(function(v) { return v !== "" })
    if (modes.length === 0) modes = [currentMode(m)]

    out.push({
      name: String(m.name || ""),
      description: String(m.description || ""),
      x: Math.round(Number(m.x) || 0),
      y: Math.round(Number(m.y) || 0),
      mode: currentMode(m),
      scale: scale,
      transform: transform,
      logicalW: logicalW,
      logicalH: logicalH,
      disabled: !!m.disabled,
      focused: !!m.focused,
      availableModes: modes
    })
  }
  return out
}

// Fit the bounding box of all enabled monitors into a w x h canvas.
// Returns per-monitor scale k and a translation (ox, oy) so that
// px = monitor.x * k + ox  (same for y).
function geometry(monitors, w, h) {
  var enabled = []
  for (var i = 0; i < monitors.length; i++)
    if (!monitors[i].disabled) enabled.push(monitors[i])

  var minX = 0, minY = 0, maxX = 0, maxY = 0
  for (var j = 0; j < enabled.length; j++) {
    var m = enabled[j]
    minX = Math.min(minX, m.x)
    minY = Math.min(minY, m.y)
    maxX = Math.max(maxX, m.x + m.logicalW)
    maxY = Math.max(maxY, m.y + m.logicalH)
  }

  var bw = Math.max(1, maxX - minX)
  var bh = Math.max(1, maxY - minY)
  var pad = 16
  var k = Math.min((w - pad) / bw, (h - pad) / bh)
  k = Math.min(k, 2.0)
  k = Math.max(k, 0.05)

  var ox = (w - bw * k) / 2 - minX * k
  var oy = (h - bh * k) / 2 - minY * k
  return { k: k, ox: ox, oy: oy }
}

function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

// True when monitor `index` at (nx, ny) overlaps any other enabled monitor.
function overlapsAny(monitors, index, nx, ny) {
  var m = monitors[index]
  if (!m || m.disabled) return false
  var self = { x: nx, y: ny, w: m.logicalW, h: m.logicalH }
  for (var i = 0; i < monitors.length; i++) {
    if (i === index || monitors[i].disabled) continue
    var o = monitors[i]
    if (intersects(self, { x: o.x, y: o.y, w: o.logicalW, h: o.logicalH })) return true
  }
  return false
}

// Names of other enabled monitors that overlap the dragged screen at (nx, ny).
function overlappedNames(monitors, index, nx, ny) {
  var out = []
  var m = monitors[index]
  if (!m || m.disabled) return out
  var self = { x: nx, y: ny, w: m.logicalW, h: m.logicalH }
  for (var i = 0; i < monitors.length; i++) {
    if (i === index || monitors[i].disabled) continue
    var o = monitors[i]
    if (intersects(self, { x: o.x, y: o.y, w: o.logicalW, h: o.logicalH })) out.push(o.name)
  }
  return out
}

// Nearest position (L1 distance from nx,ny) where monitor `index` does not
// overlap any other enabled monitor. Candidates are edge placements around
// every other screen plus safe anchors at the union corners.
function resolveNonOverlap(monitors, index, nx, ny) {
  var m = monitors[index]
  if (!m || m.disabled) return { x: nx, y: ny }

  var best = null
  function consider(cx, cy) {
    if (overlapsAny(monitors, index, cx, cy)) return
    var d = Math.abs(cx - nx) + Math.abs(cy - ny)
    if (!best || d < best.d) best = { x: cx, y: cy, d: d }
  }

  consider(nx, ny)

  for (var i = 0; i < monitors.length; i++) {
    if (i === index || monitors[i].disabled) continue
    var o = monitors[i]
    var mw = m.logicalW, mh = m.logicalH
    var cxList = [o.x - mw, o.x + o.logicalW, o.x, o.x + o.logicalW - mw]
    var cyList = [o.y, o.y + o.logicalH - mh]
    for (var a = 0; a < cxList.length; a++)
      for (var b = 0; b < cyList.length; b++)
        consider(cxList[a], cyList[b])

    cyList = [o.y - mh, o.y + o.logicalH, o.y, o.y + o.logicalH - mh]
    cxList = [o.x, o.x + o.logicalW - mw]
    for (a = 0; a < cxList.length; a++)
      for (b = 0; b < cyList.length; b++)
        consider(cxList[a], cyList[b])
  }

  // Anchors: the four union corners, then origin.
  var minX = 0, minY = 0, maxX = 0, maxY = 0, j
  for (j = 0; j < monitors.length; j++) {
    var mon = monitors[j]
    if (mon.disabled) continue
    minX = Math.min(minX, mon.x)
    minY = Math.min(minY, mon.y)
    maxX = Math.max(maxX, mon.x + mon.logicalW)
    maxY = Math.max(maxY, mon.y + mon.logicalH)
  }
  consider(minX, minY)
  consider(maxX - mw, minY)
  consider(minX, maxY - mh)
  consider(maxX - mw, maxY - mh)
  consider(0, 0)

  if (best) return { x: Math.max(0, best.x), y: Math.max(0, best.y) }
  return { x: Math.max(0, nx), y: Math.max(0, ny) }
}

// Keep the rect inside the canvas (positions always >= 0, matching how the
// preview ring works in system settings panels).
function clampLogical(m, nx, ny, canvasW, canvasH) {
  return {
    x: Math.min(Math.max(0, nx), Math.max(0, canvasW) - m.logicalW),
    y: Math.min(Math.max(0, ny), Math.max(0, canvasH) - m.logicalH)
  }
}

// Snap a drag landing at (nx, ny) (logical pixels) onto nearby monitor
// edges, exactly as screen-arrangement UIs do it (magnetic edges).
function snapPositions(monitors, index, nx, ny, k) {
  var m = monitors[index]
  if (!m || m.disabled) return { x: nx, y: ny }

  var thresh = 14 / (k > 0 ? k : 1)
  var candidates = []
  function consider(x, y, d) {
    if (d <= thresh) candidates.push({ x: x, y: y, d: d })
  }

  var i
  for (i = 0; i < monitors.length; i++) {
    if (i === index || monitors[i].disabled) continue
    var o = monitors[i]
    var myLeft = nx, myRight = nx + m.logicalW
    var myTop = ny, myBottom = ny + m.logicalH
    var oLeft = o.x, oRight = o.x + o.logicalW
    var oTop = o.y, oBottom = o.y + o.logicalH

    var xOverlaps = myLeft < oRight && myRight > oLeft
    var yOverlaps = myTop < oBottom && myBottom > oTop

    if (yOverlaps) {
      consider(oLeft, ny, Math.abs(myLeft - oLeft))
      consider(oLeft - m.logicalW, ny, Math.abs(myRight - oLeft))
      consider(oRight - m.logicalW, ny, Math.abs(myRight - oRight))
      consider(oRight, ny, Math.abs(myLeft - oRight))
    }
    if (xOverlaps) {
      consider(nx, oTop, Math.abs(myTop - oTop))
      consider(nx, oTop - m.logicalH, Math.abs(myBottom - oTop))
      consider(nx, oBottom - m.logicalH, Math.abs(myBottom - oBottom))
      consider(nx, oBottom, Math.abs(myTop - oBottom))
    }
  }

  // Anchor to the union bounding box and origin so arrangements stay tidy.
  var minX = 0, minY = 0, maxX = 0, maxY = 0
  for (i = 0; i < monitors.length; i++) {
    var mon = monitors[i]
    if (mon.disabled) continue
    minX = Math.min(minX, mon.x)
    minY = Math.min(minY, mon.y)
    maxX = Math.max(maxX, mon.x + mon.logicalW)
    maxY = Math.max(maxY, mon.y + mon.logicalH)
  }
  consider(minX, ny, Math.abs(nx - minX))
  consider(maxX - m.logicalW, ny, Math.abs(nx + m.logicalW - maxX))
  consider(nx, minY, Math.abs(ny - minY))
  consider(nx, maxY - m.logicalH, Math.abs(ny + m.logicalH - maxY))
  consider(0, 0, Math.abs(nx) + Math.abs(ny))

  if (candidates.length === 0) return { x: nx, y: ny }

  var best = candidates[0]
  for (i = 1; i < candidates.length; i++)
    if (candidates[i].d < best.d) best = candidates[i]
  return { x: best.x, y: best.y }
}

function boundsOf(monitors) {
  var minX = 0, minY = 0, maxX = 0, maxY = 0
  var i
  for (i = 0; i < monitors.length; i++) {
    var m = monitors[i]
    if (m.disabled) continue
    minX = Math.min(minX, m.x)
    minY = Math.min(minY, m.y)
    maxX = Math.max(maxX, m.x + m.logicalW)
    maxY = Math.max(maxY, m.y + m.logicalH)
  }
  return { minX: minX, minY: minY, maxX: maxX, maxY: maxY }
}

// Center a monitor within the union of all enabled screens.
function centerFor(monitors, index) {
  var m = monitors[index]
  if (!m || m.disabled) return null
  var b = boundsOf(monitors)
  return {
    x: Math.round((b.minX + b.maxX - m.logicalW) / 2),
    y: Math.round((b.minY + b.maxY - m.logicalH) / 2)
  }
}

// Arrangement presets. Returns a list of { index, x, y }.
//   "row-main": left-to-right row, main/focused screen first at the origin
//   "row":      left-to-right row, current leftmost screen first
//   "row-gap":  left-to-right row with a gap between screens
//   "stack":    vertical stack, screens stacked downwards at x = 0
function presetLayout(monitors, kind, gap) {
  var out = []
  var enabled = []
  var i
  var g = (gap !== undefined && gap !== null) ? gap : 10
  for (i = 0; i < monitors.length; i++) {
    if (!monitors[i].disabled) enabled.push({ index: i, m: monitors[i] })
  }
  if (enabled.length === 0) return out

  enabled.sort(function(a, b) {
    return (a.m.x - b.m.x) || (a.m.y - b.m.y) || (a.m.name < b.m.name ? -1 : 1)
  })

  var first = enabled[0].index
  if (kind === "row-main") {
    for (i = 0; i < enabled.length; i++)
      if (enabled[i].m.focused) { first = enabled[i].index; break }
  }

  var lead = 0
  for (i = 0; i < enabled.length; i++) {
    if (enabled[i].index === first) { lead = i; break }
  }
  enabled.splice(lead, 0, enabled.splice(lead, 1)[0])

  var cursorY = 0
  var cursorX = 0
  for (i = 0; i < enabled.length; i++) {
    var m = enabled[i].m
    if (kind === "stack") {
      out.push({ index: enabled[i].index, x: 0, y: cursorY })
      cursorY += m.logicalH + g
    } else {
      out.push({ index: enabled[i].index, x: cursorX, y: 0 })
      cursorX += m.logicalW + g
    }
  }
  return out
}

function keywordString(monitors, index) {
  var m = monitors[index]
  if (!m) return ""
  if (m.disabled) return m.name + ",disabled"
  var base = m.name + "," + m.mode + "," + Math.round(m.x) + "x" + Math.round(m.y) + "," + m.scale
  if (m.transform % 4 !== 0) base += ",," + (m.transform % 4)
  return base
}

// Parse a normalised mode ("1920x1080@59.94", "preferred", ...) into the
// un-rotated pixel size it describes.
function resolutionOf(mode) {
  var s = String(mode || "")
  var m = s.match(/(\d+)x(\d+)/)
  if (m) return { w: Math.max(1, Number(m[1]) || 1), h: Math.max(1, Number(m[2]) || 1) }
  return { w: 1920, h: 1080 }
}

// Build a clean copy: all overlaps resolved and every position kept in the
// >= 0 quadrant, so a saved monitor rule is always sane for the compositor.
function sanitize(monitors) {
  var list = monitors.map(function(m) { return clone(m) })
  if (list.length < 2) return list

  var changed = false
  // A few passes untangle chains of overlapping screens.
  for (var pass = 0; pass < 4; pass++) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].disabled || !overlapsAny(list, i, list[i].x, list[i].y)) continue
      var p = resolveNonOverlap(list, i, list[i].x, list[i].y)
      if (p.x !== list[i].x || p.y !== list[i].y) {
        list[i].x = p.x
        list[i].y = p.y
        changed = true
      }
    }
  }
  for (var j = 0; j < list.length; j++) {
    if (Math.max(0, list[j].x) !== list[j].x || Math.max(0, list[j].y) !== list[j].y) {
      list[j].x = Math.max(0, list[j].x)
      list[j].y = Math.max(0, list[j].y)
      changed = true
    }
  }
  return { list: list, changed: changed }
}

function luaFor(monitors) {
  var L = []
  L.push("-- Generated by the Display layout panel: Monitors layout.")
  L.push("-- Edit by hand if you like; the panel overwrites this file on Save.")
  L.push("")
  L.push("local omarchy_gdk_scale = 1")
  L.push("local omarchy_monitor_scale = 1.25")
  L.push("")
  L.push("hl.env(\"GDK_SCALE\", tostring(omarchy_gdk_scale))")
  L.push("hl.monitor({ output = \"\", mode = \"preferred\", position = \"auto\", scale = omarchy_monitor_scale })")
  L.push("")

  for (var i = 0; i < monitors.length; i++) {
    var m = monitors[i]
    var line
    if (m.disabled) {
      line = "hl.monitor({ output = \"" + m.name + "\", disabled = true })"
    } else {
      var parts = []
      parts.push("output = \"" + m.name + "\"")
      parts.push("mode = \"" + m.mode + "\"")
      parts.push("position = \"" + Math.round(m.x) + "x" + Math.round(m.y) + "\"")
      parts.push("scale = " + m.scale)
      if (m.transform % 4 !== 0) parts.push("transform = " + (m.transform % 4))
      line = "hl.monitor({ " + parts.join(", ") + " })"
    }
    L.push(line)
  }
  L.push("")
  return L.join("\n")
}