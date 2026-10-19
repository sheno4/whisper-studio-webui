/* MIT NaughtyDuk: exact NaughtyDOM module extracted from liquidGL 88f681ab7035fd55b04f63edff1841e32c4199e9. See UPSTREAM.md. */
  export const NaughtyDOM = (() => {
    const IDENT = [1, 0, 0, 1, 0, 0];
    const CLIP_OVERFLOW = /^(hidden|clip|scroll|auto)$/;

    function mul(m, n) {
      return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
      ];
    }

    function apply(m, x, y) {
      return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    }

    function invertLinear(m) {
      const det = m[0] * m[3] - m[1] * m[2];
      if (!det || !isFinite(det)) return null;
      return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, 0, 0];
    }

    function parseMatrix(str) {
      if (!str || str === "none") return null;
      const open = str.indexOf("(");
      if (open === -1) return null;
      const kind = str.slice(0, open);
      const v = str
        .slice(open + 1, str.lastIndexOf(")"))
        .split(",")
        .map((n) => parseFloat(n));
      if (kind === "matrix" && v.length >= 6) {
        return [v[0], v[1], v[2], v[3], v[4], v[5]];
      }
      if (kind === "matrix3d" && v.length >= 16) {
        return [v[0], v[1], v[4], v[5], v[12], v[13]];
      }
      return null;
    }

    function parseOrigin(str) {
      if (!str) return [0, 0];
      const p = str.split(" ");
      return [parseFloat(p[0]) || 0, parseFloat(p[1]) || 0];
    }

    function isTransparent(color) {
      if (!color || color === "transparent" || color === "none") return true;
      const alpha = color.match(
        /^(?:rgba|hsla|hwb|lab|lch|oklab|oklch|color)\([^)]*[,/]\s*([0-9.]+)%?\s*\)$/,
      );
      return alpha ? parseFloat(alpha[1]) === 0 : false;
    }

    function splitTopLevel(value) {
      const out = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === "," && depth === 0) {
          out.push(value.slice(start, i).trim());
          start = i + 1;
        }
      }
      const tail = value.slice(start).trim();
      if (tail) out.push(tail);
      return out;
    }

    function resolveLength(token, basis) {
      if (!token) return 0;
      if (token.indexOf("%") !== -1) {
        return (parseFloat(token) / 100) * basis;
      }
      const n = parseFloat(token);
      return isNaN(n) ? 0 : n;
    }

    function cornerRadius(value, w, h) {
      if (!value) return [0, 0];
      const parts = value.split(" ").filter(Boolean);
      const rx = resolveLength(parts[0], w);
      const ry = parts.length > 1 ? resolveLength(parts[1], h) : rx;
      return [Math.max(0, rx), Math.max(0, ry)];
    }

    function parseRadii(style, w, h) {
      const r = [
        cornerRadius(style.borderTopLeftRadius, w, h),
        cornerRadius(style.borderTopRightRadius, w, h),
        cornerRadius(style.borderBottomRightRadius, w, h),
        cornerRadius(style.borderBottomLeftRadius, w, h),
      ];
      if (!r.some((c) => c[0] > 0 || c[1] > 0)) return null;
      let f = 1;
      const ratio = (sum, len) => (sum > len && sum > 0 ? len / sum : 1);
      f = Math.min(
        f,
        ratio(r[0][0] + r[1][0], w),
        ratio(r[3][0] + r[2][0], w),
        ratio(r[0][1] + r[3][1], h),
        ratio(r[1][1] + r[2][1], h),
      );
      if (f < 1) {
        for (let i = 0; i < 4; i++) {
          r[i][0] *= f;
          r[i][1] *= f;
        }
      }
      return r;
    }

    function insetRadii(radii, top, right, bottom, left) {
      if (!radii) return null;
      return [
        [Math.max(0, radii[0][0] - left), Math.max(0, radii[0][1] - top)],
        [Math.max(0, radii[1][0] - right), Math.max(0, radii[1][1] - top)],
        [Math.max(0, radii[2][0] - right), Math.max(0, radii[2][1] - bottom)],
        [Math.max(0, radii[3][0] - left), Math.max(0, radii[3][1] - bottom)],
      ];
    }

    function invert(m) {
      const det = m[0] * m[3] - m[1] * m[2];
      if (!det || !isFinite(det)) return null;
      return [
        m[3] / det,
        -m[1] / det,
        -m[2] / det,
        m[0] / det,
        (m[2] * m[5] - m[3] * m[4]) / det,
        (m[1] * m[4] - m[0] * m[5]) / det,
      ];
    }

    const imageCache = new Map();
    let svgCache = new WeakMap();
    let pending = [];

    function sameOrigin(src) {
      if (/^data:/.test(src) || /^blob:/.test(src)) return true;
      try {
        return new URL(src, location.href).origin === location.origin;
      } catch (e) {
        return false;
      }
    }

    function loadImage(src, cache = true) {
      if (!src) return null;
      if (cache && imageCache.has(src)) return imageCache.get(src);
      const img = new Image();
      const entry = { img, ready: false, failed: false };
      if (cache) imageCache.set(src, entry);
      if (!sameOrigin(src)) img.crossOrigin = "anonymous";
      const done = new Promise((resolve) => {
        img.onload = () => {
          entry.ready = true;
          resolve();
        };
        img.onerror = () => {
          entry.failed = true;
          resolve();
        };
      });
      img.src = src;
      if (img.complete && img.naturalWidth) {
        entry.ready = true;
      } else {
        pending.push(done);
      }
      return entry;
    }

    const SVG_PAINT = [
      "fill",
      "fill-opacity",
      "fill-rule",
      "stroke",
      "stroke-width",
      "stroke-opacity",
      "stroke-linecap",
      "stroke-linejoin",
      "stroke-dasharray",
      "stroke-dashoffset",
      "opacity",
      "color",
      "stop-color",
      "stop-opacity",
      "font-family",
      "font-size",
      "font-weight",
      "font-style",
      "text-anchor",
      "letter-spacing",
      "display",
      "visibility",
      "transform",
      "transform-origin",
      "mix-blend-mode",
      "clip-path",
      "mask",
      "filter",
      "marker-start",
      "marker-mid",
      "marker-end",
    ];

    function inlineSvgStyles(source, clone) {
      const computed = getComputedStyle(source);
      let css = "";
      for (let i = 0; i < SVG_PAINT.length; i++) {
        const prop = SVG_PAINT[i];
        const value = computed.getPropertyValue(prop);
        if (value) css += `${prop}:${value};`;
      }
      if (css) clone.setAttribute("style", css);
      const sk = source.children;
      const ck = clone.children;
      for (let i = 0; i < sk.length && i < ck.length; i++) {
        inlineSvgStyles(sk[i], ck[i]);
      }
    }

    function svgToImage(el) {
      const r = el.getBoundingClientRect();
      const computed = getComputedStyle(el);
      const paintSig = `${computed.color}|${computed.fill}|${computed.stroke}`;
      const signature = `${el.outerHTML.length}|${el.childElementCount}|${Math.round(r.width)}x${Math.round(r.height)}|${el.className}|${paintSig}`;
      const cached = svgCache.get(el);
      if (cached && cached.signature === signature) return cached.entry;

      const clone = el.cloneNode(true);
      inlineSvgStyles(el, clone);
      let html = new XMLSerializer().serializeToString(clone);
      if (
        !/^<svg[^>]*\swidth=/.test(html) ||
        !/^<svg[^>]*\sheight=/.test(html)
      ) {
        html = html.replace(
          /^<svg/,
          `<svg width="${r.width}" height="${r.height}"`,
        );
      }
      if (!/xmlns=/.test(html)) {
        html = html.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      const entry = loadImage(
        "data:image/svg+xml;charset=utf-8," + encodeURIComponent(html),
        false,
      );
      svgCache.set(el, { signature, entry });
      return entry;
    }

    function usableDomImage(el) {
      return (
        el.complete &&
        el.naturalWidth > 0 &&
        (sameOrigin(el.currentSrc || el.src) || !!el.crossOrigin)
      );
    }

    function layerUrls(value) {
      if (!value || value === "none") return [];
      const out = [];
      splitTopLevel(value).forEach((layer) => {
        const m = layer.match(/^url\((['"]?)(.*?)\1\)$/);
        if (m) out.push(m[2]);
      });
      return out;
    }

    const COLOR_TOKEN =
      /^(rgba?\([^)]*\)|hsla?\([^)]*\)|hwb\([^)]*\)|(?:ok)?lab\([^)]*\)|(?:ok)?lch\([^)]*\)|color\([^)]*\)|color-mix\([^)]*\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/;

    function parseAngle(token) {
      const v = parseFloat(token);
      if (isNaN(v)) return 180;
      if (token.indexOf("turn") !== -1) return v * 360;
      if (token.indexOf("grad") !== -1) return v * 0.9;
      if (token.indexOf("rad") !== -1) return (v * 180) / Math.PI;
      return v;
    }

    function sideAngle(spec, w, h) {
      const has = (k) => spec.indexOf(k) !== -1;
      const diag = (Math.atan2(w, h) * 180) / Math.PI;
      if (has("top") && has("right")) return diag;
      if (has("bottom") && has("right")) return 180 - diag;
      if (has("bottom") && has("left")) return 180 + diag;
      if (has("top") && has("left")) return 360 - diag;
      if (has("top")) return 0;
      if (has("right")) return 90;
      if (has("bottom")) return 180;
      if (has("left")) return 270;
      return 180;
    }

    function parseStops(parts, length) {
      const stops = [];
      parts.forEach((part) => {
        const m = part.match(COLOR_TOKEN);
        if (!m) return;
        const color = m[0];
        const rest = part.slice(color.length).trim();
        const positions = rest ? rest.split(/\s+/) : [];
        if (!positions.length) {
          stops.push({ color, pos: null });
        } else {
          positions.forEach((p) => {
            const pos =
              p.indexOf("%") !== -1
                ? parseFloat(p) / 100
                : length
                  ? parseFloat(p) / length
                  : 0;
            stops.push({ color, pos: isNaN(pos) ? null : pos });
          });
        }
      });
      if (!stops.length) return stops;
      if (stops[0].pos === null) stops[0].pos = 0;
      if (stops[stops.length - 1].pos === null) {
        stops[stops.length - 1].pos = 1;
      }
      let last = 0;
      for (let i = 0; i < stops.length; i++) {
        if (stops[i].pos === null) {
          let next = i;
          while (next < stops.length && stops[next].pos === null) next++;
          const span = stops[next].pos - last;
          for (let k = i; k < next; k++) {
            stops[k].pos = last + (span * (k - i + 1)) / (next - i + 1);
          }
          i = next - 1;
        }
        last = stops[i].pos;
        if (i > 0 && stops[i].pos < stops[i - 1].pos) {
          stops[i].pos = stops[i - 1].pos;
        }
      }
      return stops;
    }

    function repeatStops(stops) {
      if (stops.length < 2) return stops;
      const first = stops[0].pos;
      const period = stops[stops.length - 1].pos - first;
      if (period <= 0.0001) return stops;
      const out = [];
      const cycles = Math.min(Math.ceil(1 / period) + 1, 200);
      for (let c = -1; c < cycles; c++) {
        for (let i = 0; i < stops.length; i++) {
          const pos = stops[i].pos + period * c;
          if (pos < -period || pos > 1 + period) continue;
          out.push({
            color: stops[i].color,
            pos: Math.min(1, Math.max(0, pos)),
          });
        }
      }
      return out.length ? out : stops;
    }

    function resolvePosition(tokens, w, h, iw, ih) {
      let x = "50%";
      let y = "50%";
      if (tokens.length === 1) {
        x = tokens[0];
        y = "50%";
        if (tokens[0] === "top" || tokens[0] === "bottom") {
          y = tokens[0];
          x = "50%";
        }
      } else if (tokens.length >= 2) {
        x = tokens[0];
        y = tokens[1];
      }
      const map = {
        left: "0%",
        top: "0%",
        center: "50%",
        right: "100%",
        bottom: "100%",
      };
      if (map[x] !== undefined) x = map[x];
      if (map[y] !== undefined) y = map[y];
      const px =
        x.indexOf("%") !== -1
          ? (parseFloat(x) / 100) * (w - iw)
          : parseFloat(x) || 0;
      const py =
        y.indexOf("%") !== -1
          ? (parseFloat(y) / 100) * (h - ih)
          : parseFloat(y) || 0;
      return [px, py];
    }

    function makeGradient(ctx, spec, x, y, w, h) {
      const open = spec.indexOf("(");
      const kind = spec.slice(0, open);
      const body = spec.slice(open + 1, spec.lastIndexOf(")"));
      const parts = splitTopLevel(body);
      if (!parts.length) return null;
      const repeating = kind.indexOf("repeating-") === 0;
      const base = kind.replace("repeating-", "");

      if (base === "linear-gradient") {
        let angle = 180;
        if (/^(to\s|[-0-9.]+(deg|grad|rad|turn))/.test(parts[0])) {
          angle =
            parts[0].indexOf("to ") === 0
              ? sideAngle(parts[0], w, h)
              : parseAngle(parts[0]);
          parts.shift();
        }
        const rad = ((angle - 90) * Math.PI) / 180;
        const dx = Math.cos(rad);
        const dy = Math.sin(rad);
        const ar = (angle * Math.PI) / 180;
        const length = Math.abs(w * Math.sin(ar)) + Math.abs(h * Math.cos(ar));
        const cx = x + w / 2;
        const cy = y + h / 2;
        let stops = parseStops(parts, length);
        if (!stops.length) return null;
        if (repeating) stops = repeatStops(stops);
        const g = ctx.createLinearGradient(
          cx - (dx * length) / 2,
          cy - (dy * length) / 2,
          cx + (dx * length) / 2,
          cy + (dy * length) / 2,
        );
        stops.forEach((s) => {
          try {
            g.addColorStop(Math.min(1, Math.max(0, s.pos)), s.color);
          } catch (e) {}
        });
        return { gradient: g };
      }

      if (base === "radial-gradient") {
        let shape = "ellipse";
        let sizing = "farthest-corner";
        let posTokens = [];
        let explicit = [];
        if (!COLOR_TOKEN.test(parts[0]) || /\bat\b/.test(parts[0])) {
          const head = parts[0];
          const atIndex = head.indexOf(" at ");
          const geom = (atIndex === -1 ? head : head.slice(0, atIndex)).trim();
          if (atIndex !== -1) {
            posTokens = head
              .slice(atIndex + 4)
              .trim()
              .split(/\s+/);
          }
          geom.split(/\s+/).forEach((tok) => {
            if (tok === "circle" || tok === "ellipse") shape = tok;
            else if (/closest|farthest/.test(tok)) sizing = tok;
            else if (tok) explicit.push(tok);
          });
          if (geom || atIndex !== -1) parts.shift();
        }
        const cxy = posTokens.length
          ? resolvePosition(posTokens, w, h, 0, 0)
          : [w / 2, h / 2];
        const cx = x + cxy[0];
        const cy = y + cxy[1];
        const lx = cxy[0];
        const ly = cxy[1];
        let rx;
        let ry;
        if (explicit.length) {
          rx = resolveLength(explicit[0], w);
          ry = explicit.length > 1 ? resolveLength(explicit[1], h) : rx;
        } else {
          const dxs = [Math.abs(lx), Math.abs(w - lx)];
          const dys = [Math.abs(ly), Math.abs(h - ly)];
          const near = sizing.indexOf("closest") === 0;
          const sx = near ? Math.min(dxs[0], dxs[1]) : Math.max(dxs[0], dxs[1]);
          const sy = near ? Math.min(dys[0], dys[1]) : Math.max(dys[0], dys[1]);
          if (sizing.indexOf("side") !== -1) {
            rx = sx;
            ry = sy;
          } else {
            rx = Math.sqrt(sx * sx + sy * sy);
            ry = rx;
            if (shape === "ellipse") {
              rx = sx * Math.SQRT2;
              ry = sy * Math.SQRT2;
            }
          }
          if (shape === "circle") {
            rx =
              sizing.indexOf("closest") === 0
                ? Math.min(sx, sy)
                : Math.max(sx, sy);
            if (sizing.indexOf("corner") !== -1)
              rx = Math.sqrt(sx * sx + sy * sy);
            ry = rx;
          }
        }
        rx = Math.max(0.01, rx);
        ry = Math.max(0.01, ry);
        let stops = parseStops(parts, rx);
        if (!stops.length) return null;
        if (repeating) stops = repeatStops(stops);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
        stops.forEach((s) => {
          try {
            g.addColorStop(Math.min(1, Math.max(0, s.pos)), s.color);
          } catch (e) {}
        });
        return { gradient: g, scaleY: ry / rx, cx, cy };
      }

      if (base === "conic-gradient" && ctx.createConicGradient) {
        let from = 0;
        let posTokens = [];
        if (/^(from\s|at\s)/.test(parts[0])) {
          const head = parts[0];
          const atIndex = head.indexOf(" at ");
          const fromPart = atIndex === -1 ? head : head.slice(0, atIndex);
          if (fromPart.indexOf("from") === 0) {
            from = parseAngle(fromPart.replace("from", "").trim());
          }
          if (atIndex !== -1) {
            posTokens = head
              .slice(atIndex + 4)
              .trim()
              .split(/\s+/);
          }
          parts.shift();
        }
        const cxy = posTokens.length
          ? resolvePosition(posTokens, w, h, 0, 0)
          : [w / 2, h / 2];
        let stops = parseStops(parts, 360);
        if (!stops.length) return null;
        if (repeating) stops = repeatStops(stops);
        const g = ctx.createConicGradient(
          ((from - 90) * Math.PI) / 180,
          x + cxy[0],
          y + cxy[1],
        );
        stops.forEach((s) => {
          try {
            g.addColorStop(Math.min(1, Math.max(0, s.pos)), s.color);
          } catch (e) {}
        });
        return { gradient: g };
      }

      return null;
    }

    function boxFor(kind, node, style) {
      let x = node.x;
      let y = node.y;
      let w = node.w;
      let h = node.h;
      let radii = node.radii;
      const bt = parseFloat(style.borderTopWidth) || 0;
      const br = parseFloat(style.borderRightWidth) || 0;
      const bb = parseFloat(style.borderBottomWidth) || 0;
      const bl = parseFloat(style.borderLeftWidth) || 0;
      if (kind === "padding-box" || kind === "content-box") {
        x += bl;
        y += bt;
        w -= bl + br;
        h -= bt + bb;
        radii = insetRadii(radii, bt, br, bb, bl);
        if (kind === "content-box") {
          const pt = parseFloat(style.paddingTop) || 0;
          const pr = parseFloat(style.paddingRight) || 0;
          const pb = parseFloat(style.paddingBottom) || 0;
          const pl = parseFloat(style.paddingLeft) || 0;
          x += pl;
          y += pt;
          w -= pl + pr;
          h -= pt + pb;
          radii = insetRadii(radii, pt, pr, pb, pl);
        }
      }
      return { x, y, w: Math.max(0, w), h: Math.max(0, h), radii };
    }

    function tracePath(ctx, x, y, w, h, radii) {
      if (w <= 0 || h <= 0) return;
      if (!radii) {
        ctx.rect(x, y, w, h);
        return;
      }
      const [tl, tr, br, bl] = radii;
      const HALF = Math.PI / 2;
      ctx.moveTo(x + tl[0], y);
      ctx.lineTo(x + w - tr[0], y);
      if (tr[0] > 0 || tr[1] > 0) {
        ctx.ellipse(x + w - tr[0], y + tr[1], tr[0], tr[1], 0, -HALF, 0);
      }
      ctx.lineTo(x + w, y + h - br[1]);
      if (br[0] > 0 || br[1] > 0) {
        ctx.ellipse(x + w - br[0], y + h - br[1], br[0], br[1], 0, 0, HALF);
      }
      ctx.lineTo(x + bl[0], y + h);
      if (bl[0] > 0 || bl[1] > 0) {
        ctx.ellipse(x + bl[0], y + h - bl[1], bl[0], bl[1], 0, HALF, Math.PI);
      }
      ctx.lineTo(x, y + tl[1]);
      if (tl[0] > 0 || tl[1] > 0) {
        ctx.ellipse(
          x + tl[0],
          y + tl[1],
          tl[0],
          tl[1],
          0,
          Math.PI,
          Math.PI + HALF,
        );
      }
      ctx.closePath();
    }

    function borderBoxSize(el, style) {
      let w = parseFloat(style.width);
      let h = parseFloat(style.height);
      if (isNaN(w) || isNaN(h)) {
        if (typeof el.offsetWidth === "number" && el.offsetWidth) {
          return { w: el.offsetWidth, h: el.offsetHeight };
        }
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      }
      if (style.boxSizing !== "border-box") {
        w +=
          parseFloat(style.paddingLeft) +
          parseFloat(style.paddingRight) +
          parseFloat(style.borderLeftWidth) +
          parseFloat(style.borderRightWidth);
        h +=
          parseFloat(style.paddingTop) +
          parseFloat(style.paddingBottom) +
          parseFloat(style.borderTopWidth) +
          parseFloat(style.borderBottomWidth);
      }
      return { w, h };
    }

    function isStackingContext(el, style) {
      if (style.position !== "static" && style.zIndex !== "auto") return true;
      if (style.position === "fixed" || style.position === "sticky")
        return true;
      if (parseFloat(style.opacity) < 1) return true;
      if (style.transform && style.transform !== "none") return true;
      if (style.filter && style.filter !== "none") return true;
      if (style.isolation === "isolate") return true;
      if (style.mixBlendMode && style.mixBlendMode !== "normal") return true;
      if (/paint|layout|strict|content/.test(style.contain || "")) return true;
      if (style.webkitOverflowScrolling === "touch") return true;
      return false;
    }

    function measureRuns(el, style) {
      const runs = [];
      if (style.visibility !== "visible") return runs;

      const transform = style.textTransform;
      const kids = el.childNodes;
      let range = null;

      for (let i = 0; i < kids.length; i++) {
        const textNode = kids[i];
        if (textNode.nodeType !== 3) continue;
        const raw = textNode.data;
        if (!raw || !raw.trim()) continue;
        if (!range) range = document.createRange();

        const re = /\S+/g;
        let match;
        while ((match = re.exec(raw)) !== null) {
          try {
            range.setStart(textNode, match.index);
            range.setEnd(textNode, match.index + match[0].length);
          } catch (e) {
            continue;
          }
          const rects = range.getClientRects();
          if (!rects.length) continue;

          let text = match[0];
          if (transform === "uppercase") text = text.toUpperCase();
          else if (transform === "lowercase") text = text.toLowerCase();
          else if (transform === "capitalize") {
            text = text.replace(/\b\w/g, (c) => c.toUpperCase());
          }

          if (rects.length === 1) {
            const r = rects[0];
            runs.push({
              text,
              left: r.left,
              top: r.top,
              right: r.right,
              height: r.height,
            });
          } else {
            const per = Math.ceil(text.length / rects.length);
            for (let k = 0; k < rects.length; k++) {
              const slice = text.substr(k * per, per);
              if (!slice) continue;
              const r = rects[k];
              runs.push({
                text: slice,
                left: r.left,
                top: r.top,
                right: r.right,
                height: r.height,
              });
            }
          }
        }
      }

      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        // DOM sampling must preserve the browser's password presentation.
        // Never copy a saved/API credential into a paint plan or GPU texture.
        const value = el.value
          ? tag === "INPUT" && el.type === "password"
            ? "\u2022".repeat(Array.from(el.value).length)
            : el.value
          : el.placeholder;
        if (value) runs.push({ text: value, value: true });
      }

      return runs;
    }

    function discoverAssets(el, style) {
      const layers = style.backgroundImage;
      if (layers && layers !== "none") layerUrls(layers).forEach(loadImage);
      const tag = el.tagName;
      if (tag === "IMG") {
        const src = el.currentSrc || el.src;
        if (src && !usableDomImage(el)) loadImage(src);
      } else if (tag === "svg") {
        svgToImage(el);
      }
    }

    function buildNode(el, parent, clips, ignore) {
      if (ignore && ignore(el)) return null;
      const style = getComputedStyle(el);
      if (style.display === "none") return null;

      const size = borderBoxSize(el, style);
      const rect = el.getBoundingClientRect();
      const B = parent ? parent.m : IDENT;
      const Blin = [B[0], B[1], B[2], B[3], 0, 0];
      const own = parseMatrix(style.transform);
      const N = own || IDENT;
      const Nlin = [N[0], N[1], N[2], N[3], 0, 0];
      const BN = mul(Blin, Nlin);

      let x;
      let y;
      let m;
      if (!own && (!parent || parent.untransformed)) {
        x = rect.left;
        y = rect.top;
        m = IDENT;
      } else {
        const o = parseOrigin(style.transformOrigin);
        const no = apply(Nlin, o[0], o[1]);
        const tv = [o[0] - no[0] + N[4], o[1] - no[1] + N[5]];
        const bt = apply(Blin, tv[0], tv[1]);
        const C = [bt[0] + B[4], bt[1] + B[5]];
        let minX = Infinity;
        let minY = Infinity;
        const corners = [
          [0, 0],
          [size.w, 0],
          [0, size.h],
          [size.w, size.h],
        ];
        for (let i = 0; i < corners.length; i++) {
          const p = apply(BN, corners[i][0], corners[i][1]);
          if (p[0] < minX) minX = p[0];
          if (p[1] < minY) minY = p[1];
        }
        const inv = invertLinear(Blin);
        if (!inv) return null;
        const u = apply(inv, rect.left - minX - C[0], rect.top - minY - C[1]);
        x = u[0];
        y = u[1];
        m = [BN[0], BN[1], BN[2], BN[3], C[0], C[1]];
      }

      const radii = parseRadii(style, size.w, size.h);
      const node = {
        el,
        style,
        x,
        y,
        w: size.w,
        h: size.h,
        m,
        radii,
        clips,
        opacity: parseFloat(style.opacity),
        untransformed: !own && (!parent || parent.untransformed),
        children: [],
        runs: measureRuns(el, style),
      };

      discoverAssets(el, style);

      if (
        CLIP_OVERFLOW.test(style.overflowX) ||
        CLIP_OVERFLOW.test(style.overflowY)
      ) {
        const bt = parseFloat(style.borderTopWidth);
        const br = parseFloat(style.borderRightWidth);
        const bb = parseFloat(style.borderBottomWidth);
        const bl = parseFloat(style.borderLeftWidth);
        node.childClips = clips.concat([
          {
            m,
            x: x + bl,
            y: y + bt,
            w: Math.max(0, size.w - bl - br),
            h: Math.max(0, size.h - bt - bb),
            radii: insetRadii(radii, bt, br, bb, bl),
          },
        ]);
      } else {
        node.childClips = clips;
      }

      return node;
    }

    function newStack(node) {
      return {
        node,
        negative: [],
        zeroOrAuto: [],
        positive: [],
        floats: [],
      };
    }

    function collect(node, stack, ignore) {
      if (node.el.tagName === "svg") return;
      const kids = node.el.children;
      for (let i = 0; i < kids.length; i++) {
        const child = buildNode(kids[i], node, node.childClips, ignore);
        if (!child) continue;
        const cs = child.style;
        if (isStackingContext(child.el, cs)) {
          const sub = newStack(child);
          collect(child, sub, ignore);
          const z =
            cs.position !== "static" && cs.zIndex !== "auto"
              ? parseInt(cs.zIndex, 10) || 0
              : 0;
          if (z < 0) stack.negative.push({ z, sub });
          else if (z > 0) stack.positive.push({ z, sub });
          else stack.zeroOrAuto.push(sub);
        } else if (cs.position !== "static") {
          const sub = newStack(child);
          collect(child, sub, ignore);
          stack.zeroOrAuto.push(sub);
        } else if (cs.float !== "none") {
          const sub = newStack(child);
          collect(child, sub, ignore);
          stack.floats.push(sub);
        } else {
          node.children.push(child);
          collect(child, stack, ignore);
        }
      }
    }

    function Painter(ctx, base) {
      this.ctx = ctx;
      this.base = base;
      this.activeClips = null;
      this.alphaStack = [];
    }

    Painter.prototype.space = function (m) {
      const d = mul(this.base, m);
      this.ctx.setTransform(d[0], d[1], d[2], d[3], d[4], d[5]);
    };

    Painter.prototype.setClips = function (clips) {
      if (this.activeClips === clips) return;
      const ctx = this.ctx;
      if (this.activeClips !== null) ctx.restore();
      ctx.save();
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i];
        this.space(c.m);
        ctx.beginPath();
        tracePath(ctx, c.x, c.y, c.w, c.h, c.radii);
        ctx.clip();
      }
      this.activeClips = clips;
    };

    Painter.prototype.release = function () {
      if (this.activeClips !== null) {
        this.ctx.restore();
        this.activeClips = null;
      }
    };

    Painter.prototype.shadows = function (node) {
      const value = node.style.boxShadow;
      if (!value || value === "none") return;
      const ctx = this.ctx;
      const layers = splitTopLevel(value).reverse();
      for (let i = 0; i < layers.length; i++) {
        const raw = layers[i];
        const inset = raw.indexOf("inset") !== -1;
        const body = raw.replace("inset", "").trim();
        const colorMatch = body.match(
          /^(rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+\([^)]*\)|#[0-9a-f]+|[a-z]+)/i,
        );
        if (!colorMatch) continue;
        const color = colorMatch[0];
        if (isTransparent(color)) continue;
        const nums = body
          .slice(color.length)
          .trim()
          .split(/\s+/)
          .map((n) => parseFloat(n) || 0);
        const dx = nums[0] || 0;
        const dy = nums[1] || 0;
        const blur = nums[2] || 0;
        const spread = nums[3] || 0;

        ctx.save();
        this.space(node.m);
        if (inset) {
          ctx.beginPath();
          tracePath(ctx, node.x, node.y, node.w, node.h, node.radii);
          ctx.clip();
          const gx = node.x - node.w - 100;
          const gy = node.y - node.h - 100;
          ctx.beginPath();
          ctx.rect(gx, gy, node.w * 3 + 200, node.h * 3 + 200);
          tracePath(
            ctx,
            node.x + spread,
            node.y + spread,
            node.w - spread * 2,
            node.h - spread * 2,
            insetRadii(node.radii, spread, spread, spread, spread),
          );
          ctx.shadowColor = color;
          ctx.shadowOffsetX = dx;
          ctx.shadowOffsetY = dy;
          ctx.shadowBlur = blur;
          ctx.fillStyle = "#000";
          ctx.fill("evenodd");
        } else {
          ctx.beginPath();
          tracePath(ctx, node.x, node.y, node.w, node.h, node.radii);
          const gx = node.x - node.w - blur * 2 - Math.abs(dx) - spread - 100;
          const gy = node.y - node.h - blur * 2 - Math.abs(dy) - spread - 100;
          ctx.rect(
            gx,
            gy,
            node.w * 3 + blur * 4 + Math.abs(dx) * 2 + spread * 2 + 200,
            node.h * 3 + blur * 4 + Math.abs(dy) * 2 + spread * 2 + 200,
          );
          ctx.clip("evenodd");
          ctx.shadowColor = color;
          ctx.shadowOffsetX = dx;
          ctx.shadowOffsetY = dy;
          ctx.shadowBlur = blur;
          ctx.fillStyle = "#000";
          ctx.beginPath();
          tracePath(
            ctx,
            node.x - spread,
            node.y - spread,
            node.w + spread * 2,
            node.h + spread * 2,
            insetRadii(node.radii, -spread, -spread, -spread, -spread),
          );
          ctx.fill();
        }
        ctx.restore();
      }
    };

    Painter.prototype.background = function (node) {
      const style = node.style;
      const ctx = this.ctx;
      const images = style.backgroundImage;
      const hasImages = images && images !== "none";
      if (isTransparent(style.backgroundColor) && !hasImages) return;

      const clipList = splitTopLevel(style.backgroundClip || "border-box");
      const clipBox = boxFor(clipList[clipList.length - 1], node, style);
      if (clipBox.w <= 0 || clipBox.h <= 0) return;

      if (!isTransparent(style.backgroundColor)) {
        this.space(node.m);
        ctx.beginPath();
        tracePath(
          ctx,
          clipBox.x,
          clipBox.y,
          clipBox.w,
          clipBox.h,
          clipBox.radii,
        );
        ctx.fillStyle = style.backgroundColor;
        ctx.fill();
      }

      if (!hasImages) return;

      const layers = splitTopLevel(images);
      const originList = splitTopLevel(style.backgroundOrigin || "padding-box");
      const sizeList = splitTopLevel(style.backgroundSize || "auto");
      const posList = splitTopLevel(style.backgroundPosition || "0% 0%");
      const repeatList = splitTopLevel(style.backgroundRepeat || "repeat");
      const pick = (list, i) => list[i % list.length];

      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (!layer || layer === "none") continue;
        const lClip = boxFor(pick(clipList, i), node, style);
        const origin = boxFor(pick(originList, i), node, style);
        if (lClip.w <= 0 || lClip.h <= 0) continue;

        ctx.save();
        this.space(node.m);
        ctx.beginPath();
        tracePath(ctx, lClip.x, lClip.y, lClip.w, lClip.h, lClip.radii);
        ctx.clip();

        const urlMatch = layer.match(/^url\((['"]?)(.*?)\1\)$/);
        if (urlMatch) {
          const entry = imageCache.get(urlMatch[2]);
          if (entry && entry.ready) {
            this.tile(
              entry.img,
              origin,
              pick(sizeList, i),
              pick(posList, i),
              pick(repeatList, i),
            );
          }
        } else if (/gradient\(/.test(layer)) {
          try {
            const made = makeGradient(
              ctx,
              layer,
              origin.x,
              origin.y,
              origin.w,
              origin.h,
            );
            if (made) {
              ctx.fillStyle = made.gradient;
              if (made.scaleY && Math.abs(made.scaleY - 1) > 0.001) {
                const inv = 1 / made.scaleY;
                ctx.translate(made.cx, made.cy);
                ctx.scale(1, made.scaleY);
                ctx.translate(-made.cx, -made.cy);
                ctx.fillRect(
                  lClip.x,
                  made.cy + (lClip.y - made.cy) * inv,
                  lClip.w,
                  lClip.h * inv,
                );
              } else {
                ctx.fillRect(lClip.x, lClip.y, lClip.w, lClip.h);
              }
            }
          } catch (e) {}
        }
        ctx.restore();
      }
    };

    Painter.prototype.tile = function (img, area, size, position, repeat) {
      const ctx = this.ctx;
      const nw = img.naturalWidth || img.width;
      const nh = img.naturalHeight || img.height;
      if (!nw || !nh) return;

      let dw;
      let dh;
      const ratio = nw / nh;
      if (size === "cover" || size === "contain") {
        const areaRatio = area.w / area.h;
        const wide = size === "cover" ? areaRatio < ratio : areaRatio > ratio;
        if (wide) {
          dh = area.h;
          dw = dh * ratio;
        } else {
          dw = area.w;
          dh = dw / ratio;
        }
      } else {
        const tokens = (size || "auto").split(/\s+/);
        const sx = tokens[0] || "auto";
        const sy = tokens[1] || "auto";
        if (sx === "auto" && sy === "auto") {
          dw = nw;
          dh = nh;
        } else if (sx === "auto") {
          dh = resolveLength(sy, area.h);
          dw = dh * ratio;
        } else if (sy === "auto") {
          dw = resolveLength(sx, area.w);
          dh = dw / ratio;
        } else {
          dw = resolveLength(sx, area.w);
          dh = resolveLength(sy, area.h);
        }
      }
      if (dw <= 0 || dh <= 0) return;

      const offset = resolvePosition(
        (position || "0% 0%").split(/\s+/),
        area.w,
        area.h,
        dw,
        dh,
      );
      const ox = area.x + offset[0];
      const oy = area.y + offset[1];

      if (repeat === "no-repeat") {
        ctx.drawImage(img, ox, oy, dw, dh);
        return;
      }

      const repeatX = repeat !== "repeat-y";
      const repeatY = repeat !== "repeat-x";
      const mode =
        repeatX && repeatY ? "repeat" : repeatX ? "repeat-x" : "repeat-y";
      const pattern = ctx.createPattern(img, mode);
      if (!pattern) return;

      if (pattern.setTransform && typeof DOMMatrix !== "undefined") {
        pattern.setTransform(new DOMMatrix([dw / nw, 0, 0, dh / nh, ox, oy]));
        ctx.fillStyle = pattern;
        ctx.fillRect(
          repeatX ? area.x : ox,
          repeatY ? area.y : oy,
          repeatX ? area.w : dw,
          repeatY ? area.h : dh,
        );
        return;
      }

      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(dw / nw, dh / nh);
      ctx.fillStyle = pattern;
      ctx.fillRect(
        ((repeatX ? area.x : ox) - ox) / (dw / nw),
        ((repeatY ? area.y : oy) - oy) / (dh / nh),
        (repeatX ? area.w : dw) / (dw / nw),
        (repeatY ? area.h : dh) / (dh / nh),
      );
      ctx.restore();
    };

    Painter.prototype.replaced = function (node) {
      const el = node.el;
      const tag = el.tagName;
      if (tag === "IFRAME") return;

      let source = null;
      if (tag === "IMG") {
        if (usableDomImage(el)) {
          source = el;
        } else {
          const entry = imageCache.get(el.currentSrc || el.src);
          if (entry && entry.ready) source = entry.img;
        }
      } else if (tag === "VIDEO") {
        source = el.readyState >= 2 && el.videoWidth && el.videoHeight ? el : null;
      } else if (tag === "CANVAS") {
        source = el.width && el.height ? el : null;
      } else if (tag === "svg") {
        const cached = svgCache.get(el);
        if (cached && cached.entry.ready) source = cached.entry.img;
      }
      if (!source) return;

      const style = node.style;
      const box = boxFor("content-box", node, style);
      if (box.w <= 0 || box.h <= 0) return;

      const nw = source.videoWidth || source.naturalWidth || source.width || box.w;
      const nh = source.videoHeight || source.naturalHeight || source.height || box.h;
      if (!nw || !nh) return;

      const fit = style.objectFit || "fill";
      let dw = box.w;
      let dh = box.h;
      if (fit !== "fill") {
        const ratio = nw / nh;
        const areaRatio = box.w / box.h;
        if (fit === "contain" || fit === "scale-down") {
          if (areaRatio > ratio) {
            dh = box.h;
            dw = dh * ratio;
          } else {
            dw = box.w;
            dh = dw / ratio;
          }
          if (fit === "scale-down" && (dw > nw || dh > nh)) {
            dw = nw;
            dh = nh;
          }
        } else if (fit === "cover") {
          if (areaRatio < ratio) {
            dh = box.h;
            dw = dh * ratio;
          } else {
            dw = box.w;
            dh = dw / ratio;
          }
        } else if (fit === "none") {
          dw = nw;
          dh = nh;
        }
      }

      const offset = resolvePosition(
        (style.objectPosition || "50% 50%").split(/\s+/),
        box.w,
        box.h,
        dw,
        dh,
      );

      const ctx = this.ctx;
      ctx.save();
      this.space(node.m);
      ctx.beginPath();
      tracePath(ctx, box.x, box.y, box.w, box.h, box.radii);
      ctx.clip();
      try {
        ctx.drawImage(source, box.x + offset[0], box.y + offset[1], dw, dh);
      } catch (e) {}
      ctx.restore();
    };

    Painter.prototype.text = function (node) {
      const style = node.style;
      const ctx = this.ctx;
      const strokeWidth = parseFloat(style.webkitTextStrokeWidth) || 0;
      if (isTransparent(style.color) && strokeWidth <= 0) return;

      this.setClips(node.clips);
      this.space(node.m);

      const fontSize = parseFloat(style.fontSize) || 16;
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
      if ("letterSpacing" in ctx) {
        ctx.letterSpacing =
          style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
      }
      if ("wordSpacing" in ctx) {
        ctx.wordSpacing =
          style.wordSpacing === "normal" ? "0px" : style.wordSpacing;
      }
      const rtl = style.direction === "rtl";
      ctx.direction = rtl ? "rtl" : "ltr";
      ctx.textAlign = rtl ? "right" : "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = style.color;

      const strokeColor = style.webkitTextStrokeColor;
      const strokeFirst = (style.paintOrder || "").indexOf("stroke") === 0;

      const shadows = [];
      if (style.textShadow && style.textShadow !== "none") {
        splitTopLevel(style.textShadow).forEach((raw) => {
          const cm = raw.match(COLOR_TOKEN);
          if (!cm || isTransparent(cm[0])) return;
          const nums = raw
            .slice(cm[0].length)
            .trim()
            .split(/\s+/)
            .map((n) => parseFloat(n) || 0);
          shadows.push({
            color: cm[0],
            dx: nums[0] || 0,
            dy: nums[1] || 0,
            blur: nums[2] || 0,
          });
        });
      }

      const inv = node.untransformed ? null : invert(node.m);
      const toLocal = (px, py) => (inv ? apply(inv, px, py) : [px, py]);
      const scaleY = inv ? Math.hypot(inv[2], inv[3]) : 1;

      const decoration = style.textDecorationLine;
      const decorate =
        decoration && decoration !== "none"
          ? {
              color: style.textDecorationColor || style.color,
              under: decoration.indexOf("underline") !== -1,
              through: decoration.indexOf("line-through") !== -1,
              over: decoration.indexOf("overline") !== -1,
            }
          : null;

      const draw = (text, run) => {
        if (!text) return;
        const local = toLocal(run.left, run.top);
        const metrics = ctx.measureText(text);
        const ascent =
          metrics.fontBoundingBoxAscent ||
          metrics.actualBoundingBoxAscent ||
          fontSize * 0.8;
        const descent =
          metrics.fontBoundingBoxDescent ||
          metrics.actualBoundingBoxDescent ||
          fontSize * 0.2;
        const boxH = run.height * scaleY;
        const baseline = local[1] + (boxH - (ascent + descent)) / 2 + ascent;
        const anchor = rtl ? toLocal(run.right, run.top)[0] : local[0];

        for (let s = 0; s < shadows.length; s++) {
          const sh = shadows[s];
          ctx.save();
          ctx.shadowColor = sh.color;
          ctx.shadowOffsetX = sh.dx;
          ctx.shadowOffsetY = sh.dy;
          ctx.shadowBlur = sh.blur;
          ctx.fillText(text, anchor, baseline);
          ctx.restore();
        }

        const strokeIt = () => {
          if (strokeWidth <= 0 || isTransparent(strokeColor)) return;
          ctx.save();
          ctx.lineWidth = strokeWidth * 2;
          ctx.strokeStyle = strokeColor;
          ctx.lineJoin = "round";
          ctx.strokeText(text, anchor, baseline);
          ctx.restore();
        };

        if (strokeFirst) strokeIt();
        ctx.fillText(text, anchor, baseline);
        if (!strokeFirst) strokeIt();

        if (decorate) {
          const width = metrics.width;
          const x0 = rtl ? anchor - width : anchor;
          const thickness = Math.max(1, fontSize / 14);
          ctx.save();
          ctx.fillStyle = decorate.color;
          if (decorate.under) {
            ctx.fillRect(x0, baseline + thickness * 1.5, width, thickness);
          }
          if (decorate.through) {
            ctx.fillRect(x0, baseline - ascent / 3, width, thickness);
          }
          if (decorate.over) {
            ctx.fillRect(x0, baseline - ascent, width, thickness);
          }
          ctx.restore();
        }
      };

      const runs = node.runs;
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (run.value) {
          const box = boxFor("content-box", node, style);
          const metrics = ctx.measureText(run.text);
          const ascent = metrics.fontBoundingBoxAscent || fontSize * 0.8;
          const descent = metrics.fontBoundingBoxDescent || fontSize * 0.2;
          const baseline = box.y + (box.h - (ascent + descent)) / 2 + ascent;
          ctx.fillText(run.text, rtl ? box.x + box.w : box.x, baseline);
        } else {
          draw(run.text, run);
        }
      }
    };

    Painter.prototype.borders = function (node) {
      const style = node.style;
      const widths = [
        parseFloat(style.borderTopWidth) || 0,
        parseFloat(style.borderRightWidth) || 0,
        parseFloat(style.borderBottomWidth) || 0,
        parseFloat(style.borderLeftWidth) || 0,
      ];
      const styles = [
        style.borderTopStyle,
        style.borderRightStyle,
        style.borderBottomStyle,
        style.borderLeftStyle,
      ];
      const colors = [
        style.borderTopColor,
        style.borderRightColor,
        style.borderBottomColor,
        style.borderLeftColor,
      ];
      let any = false;
      for (let i = 0; i < 4; i++) {
        if (
          widths[i] > 0 &&
          styles[i] !== "none" &&
          styles[i] !== "hidden" &&
          !isTransparent(colors[i])
        ) {
          any = true;
          break;
        }
      }
      if (!any) return;

      const ctx = this.ctx;
      const inner = insetRadii(
        node.radii,
        widths[0],
        widths[1],
        widths[2],
        widths[3],
      );
      const ix = node.x + widths[3];
      const iy = node.y + widths[0];
      const iw = Math.max(0, node.w - widths[1] - widths[3]);
      const ih = Math.max(0, node.h - widths[0] - widths[2]);

      const uniform =
        colors[0] === colors[1] &&
        colors[1] === colors[2] &&
        colors[2] === colors[3] &&
        styles[0] === styles[1] &&
        styles[1] === styles[2] &&
        styles[2] === styles[3] &&
        styles[0] === "solid";

      this.space(node.m);

      if (uniform) {
        ctx.beginPath();
        tracePath(ctx, node.x, node.y, node.w, node.h, node.radii);
        tracePath(ctx, ix, iy, iw, ih, inner);
        ctx.fillStyle = colors[0];
        ctx.fill("evenodd");
        return;
      }

      const wedges = [
        [
          [node.x, node.y],
          [node.x + node.w, node.y],
          [ix + iw, iy],
          [ix, iy],
        ],
        [
          [node.x + node.w, node.y],
          [node.x + node.w, node.y + node.h],
          [ix + iw, iy + ih],
          [ix + iw, iy],
        ],
        [
          [node.x + node.w, node.y + node.h],
          [node.x, node.y + node.h],
          [ix, iy + ih],
          [ix + iw, iy + ih],
        ],
        [
          [node.x, node.y + node.h],
          [node.x, node.y],
          [ix, iy],
          [ix, iy + ih],
        ],
      ];

      for (let i = 0; i < 4; i++) {
        if (
          widths[i] <= 0 ||
          styles[i] === "none" ||
          styles[i] === "hidden" ||
          isTransparent(colors[i])
        ) {
          continue;
        }
        ctx.save();
        this.space(node.m);
        const wedge = wedges[i];
        ctx.beginPath();
        ctx.moveTo(wedge[0][0], wedge[0][1]);
        for (let p = 1; p < wedge.length; p++) {
          ctx.lineTo(wedge[p][0], wedge[p][1]);
        }
        ctx.closePath();
        ctx.clip();
        ctx.beginPath();
        tracePath(ctx, node.x, node.y, node.w, node.h, node.radii);
        tracePath(ctx, ix, iy, iw, ih, inner);
        ctx.fillStyle = colors[i];
        ctx.fill("evenodd");
        ctx.restore();
      }
    };

    Painter.prototype.node = function (node) {
      if (node.style.visibility !== "visible") return;
      if (node.w <= 0 || node.h <= 0) return;
      this.setClips(node.clips);
      this.shadows(node);
      this.background(node);
      this.borders(node);
      this.replaced(node);
    };

    const OP_BOX = 0;
    const OP_TEXT = 1;
    const OP_ALPHA_PUSH = 2;
    const OP_ALPHA_POP = 3;

    function emitInFlowBoxes(node, out) {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        out.push({ t: OP_BOX, node: child });
        emitInFlowBoxes(child, out);
      }
    }

    function emitInFlowText(node, out) {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.runs.length) out.push({ t: OP_TEXT, node: child });
        emitInFlowText(child, out);
      }
    }

    function emitStack(stack, out) {
      const alpha = stack.node.opacity;
      const fade = !isNaN(alpha) && alpha < 1;
      if (fade) out.push({ t: OP_ALPHA_PUSH, alpha });

      out.push({ t: OP_BOX, node: stack.node });

      const byZ = (a, b) => a.z - b.z;
      stack.negative.sort(byZ);
      for (let i = 0; i < stack.negative.length; i++) {
        emitStack(stack.negative[i].sub, out);
      }

      emitInFlowBoxes(stack.node, out);

      if (stack.node.runs.length) out.push({ t: OP_TEXT, node: stack.node });
      emitInFlowText(stack.node, out);

      for (let i = 0; i < stack.floats.length; i++) {
        emitStack(stack.floats[i], out);
      }
      for (let i = 0; i < stack.zeroOrAuto.length; i++) {
        emitStack(stack.zeroOrAuto[i], out);
      }
      stack.positive.sort(byZ);
      for (let i = 0; i < stack.positive.length; i++) {
        emitStack(stack.positive[i].sub, out);
      }

      if (fade) out.push({ t: OP_ALPHA_POP });
    }

    Painter.prototype.run = function (ops, from, budgetMs) {
      const ctx = this.ctx;
      const deadline = budgetMs ? performance.now() + budgetMs : 0;
      for (let i = from; i < ops.length; i++) {
        const op = ops[i];
        if (op.t === OP_BOX) {
          this.node(op.node);
        } else if (op.t === OP_TEXT) {
          this.text(op.node);
        } else if (op.t === OP_ALPHA_PUSH) {
          this.release();
          this.alphaStack.push(ctx.globalAlpha);
          ctx.globalAlpha = ctx.globalAlpha * op.alpha;
        } else {
          this.release();
          ctx.globalAlpha = this.alphaStack.pop();
        }
        if (deadline && (i & 63) === 0 && performance.now() > deadline) {
          return i + 1;
        }
      }
      return ops.length;
    };

    function measure(element, options) {
      const opts = options || {};
      const scale = opts.scale || 1;
      const ignore = opts.ignoreElements || null;

      pending = [];
      const root = buildNode(element, null, [], ignore);
      if (!root) return null;
      if (opts.rootOpacity != null) root.opacity = opts.rootOpacity;

      const stack = newStack(root);
      collect(root, stack, ignore);

      const ops = [];
      emitStack(stack, ops);

      let base = [scale, 0, 0, scale, -root.x * scale, -root.y * scale];
      if (!root.untransformed) {
        const rootInv = invert(root.m);
        if (rootInv) base = mul(base, rootInv);
      }

      const assets = pending;
      pending = [];

      return {
        root,
        ops,
        base,
        scale,
        assets,
        width: opts.width != null ? opts.width : root.w,
        height: opts.height != null ? opts.height : root.h,
        backgroundColor: opts.backgroundColor || null,
      };
    }

    function prepareCanvas(plan, canvas) {
      const cw = Math.max(1, Math.round(plan.width * plan.scale));
      const ch = Math.max(1, Math.round(plan.height * plan.scale));
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;

      const ctx = canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (plan.backgroundColor) {
        ctx.fillStyle = plan.backgroundColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      return ctx;
    }

    function paint(plan, canvas, region) {
      const ctx = region
        ? canvas.getContext("2d")
        : prepareCanvas(plan, canvas);
      if (region) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.rect(region.x, region.y, region.w, region.h);
        ctx.clip();
        ctx.clearRect(region.x, region.y, region.w, region.h);
        if (plan.backgroundColor) {
          ctx.fillStyle = plan.backgroundColor;
          ctx.fillRect(region.x, region.y, region.w, region.h);
        }
      }
      const painter = new Painter(ctx, plan.base);
      painter.run(plan.ops, 0, 0);
      painter.release();
      if (region) ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return canvas;
    }

    const BOX_PAINT = [
      "visibility",
      "boxShadow",
      "backgroundColor",
      "backgroundImage",
      "backgroundClip",
      "backgroundOrigin",
      "backgroundSize",
      "backgroundPosition",
      "backgroundRepeat",
      "objectFit",
      "objectPosition",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "borderTopStyle",
      "borderRightStyle",
      "borderBottomStyle",
      "borderLeftStyle",
      "borderTopColor",
      "borderRightColor",
      "borderBottomColor",
      "borderLeftColor",
    ];
    const TEXT_PAINT = [
      "color",
      "fontStyle",
      "fontWeight",
      "fontSize",
      "fontFamily",
      "letterSpacing",
      "wordSpacing",
      "direction",
      "textShadow",
      "webkitTextStrokeWidth",
      "webkitTextStrokeColor",
      "paintOrder",
      "textDecorationLine",
      "textDecorationColor",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
    ];

    function paintLayer(plan, canvas, previous, force) {
      const records = [];
      let supported = true;
      const geometry = (box) => {
        const m = mul(plan.base, box.m);
        if (m[0] !== plan.scale || m[1] || m[2] || m[3] !== plan.scale)
          supported = false;
        return [
          box.x * m[0] + m[4],
          box.y * m[3] + m[5],
          box.w * m[0],
          box.h * m[3],
          box.radii,
        ];
      };
      for (const op of plan.ops) {
        const node = op.node;
        if (!node) {
          records.push({ type: op.t, key: op.alpha });
          continue;
        }
        const bounds = geometry(node);
        const clips = node.clips.map(geometry);
        if (!supported) {
          paint(plan, canvas);
          return { records: null, changed: true };
        }
        const inv = op.t === OP_TEXT ? invert(node.m) : null;
        const m = op.t === OP_TEXT ? mul(plan.base, node.m) : null;
        const runs = (op.t === OP_TEXT ? node.runs : []).map((run) => {
          const local =
            inv && !run.value ? apply(inv, run.left, run.top) : [0, 0];
          return [
            run.text,
            run.value,
            local[0] * m[0] + m[4],
            local[1] * m[3] + m[5],
            run.right - run.left,
            run.height,
          ];
        });
        const style = node.style;
        const source = svgCache.get(node.el)?.entry;
        records.push({
          type: op.t,
          el: node.el,
          bounds,
          source,
          volatile:
            op.t === OP_BOX &&
            (node.el.tagName === "IMG" ||
              node.el.tagName === "CANVAS" ||
              node.el.tagName === "VIDEO" ||
              style.backgroundImage.includes("url(")),
          bounded:
            op.t === OP_BOX && (!style.boxShadow || style.boxShadow === "none"),
          key: JSON.stringify([
            bounds,
            clips,
            op.t === OP_TEXT ? runs : null,
            (op.t === OP_TEXT ? TEXT_PAINT : BOX_PAINT).map(
              (name) => style[name],
            ),
            source?.ready,
          ]),
        });
      }
      let full =
        force ||
        !supported ||
        !previous?.records ||
        previous.records.length !== records.length ||
        previous.width !== plan.width ||
        previous.height !== plan.height ||
        previous.scale !== plan.scale;
      let left = Infinity,
        top = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      if (!full) {
        for (let i = 0; i < records.length; i++) {
          const next = records[i],
            old = previous.records[i];
          if (next.type !== old.type || next.el !== old.el) {
            full = true;
            break;
          }
          if (
            next.key === old.key &&
            next.source === old.source &&
            !next.volatile
          )
            continue;
          if (!next.bounded || !old.bounded) {
            full = true;
            break;
          }
          for (const record of [old, next]) {
            const [x, y, w, h] = record.bounds;
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x + w);
            bottom = Math.max(bottom, y + h);
          }
        }
      }
      const x = Math.max(0, Math.floor(left) - 2);
      const y = Math.max(0, Math.floor(top) - 2);
      const w = Math.min(canvas.width, Math.ceil(right) + 2) - x;
      const h = Math.min(canvas.height, Math.ceil(bottom) + 2) - y;
      const changed = full || (w > 0 && h > 0);
      if (changed) paint(plan, canvas, full ? null : { x, y, w, h });
      return {
        records: supported ? records : null,
        width: plan.width,
        height: plan.height,
        scale: plan.scale,
        changed,
      };
    }

    function nextTask() {
      return new Promise((resolve) => {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(() => resolve(), { timeout: 32 });
        } else {
          setTimeout(resolve, 0);
        }
      });
    }

    async function paintChunked(plan, canvas, budgetMs) {
      const ctx = prepareCanvas(plan, canvas);
      const painter = new Painter(ctx, plan.base);
      let index = 0;
      while (index < plan.ops.length) {
        index = painter.run(plan.ops, index, budgetMs);
        if (index < plan.ops.length) await nextTask();
      }
      painter.release();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return canvas;
    }

    function rasterise(element, options) {
      const opts = options || {};
      const canvas = opts.canvas || document.createElement("canvas");
      const plan = measure(element, opts);
      if (!plan) {
        canvas.width = Math.max(
          1,
          Math.round((opts.width || 1) * (opts.scale || 1)),
        );
        canvas.height = Math.max(
          1,
          Math.round((opts.height || 1) * (opts.scale || 1)),
        );
        return canvas;
      }
      return paint(plan, canvas);
    }

    async function rasteriseAsync(element, options) {
      const opts = options || {};
      const canvas = opts.canvas || document.createElement("canvas");
      let plan = measure(element, opts);
      if (!plan) {
        canvas.width = Math.max(
          1,
          Math.round((opts.width || 1) * (opts.scale || 1)),
        );
        canvas.height = Math.max(
          1,
          Math.round((opts.height || 1) * (opts.scale || 1)),
        );
        return canvas;
      }
      if (plan.assets.length) {
        await Promise.all(plan.assets);
        plan = measure(element, opts) || plan;
      }
      return paintChunked(plan, canvas, opts.budgetMs || 8);
    }

    return {
      release() { imageCache.clear(); svgCache = new WeakMap(); },
      measure,
      paint,
      paintLayer,
      paintChunked,
      rasterise,
      rasteriseAsync,
    };
  })();

