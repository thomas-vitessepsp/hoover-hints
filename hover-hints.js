(function () {
  "use strict";

  var currentScript = document.currentScript;
  var scriptUrl = new URL(currentScript && currentScript.src ? currentScript.src : window.location.href);
  var csvUrl = getDatasetValue("csv") || getDatasetValue("hintsCsv");
  var csvSelector = getDatasetValue("csvSelector");
  var scopeSelector = getDatasetValue("scope") || "body";
  var wholeWord = getDatasetValue("wholeWord") !== "false";
  var caseSensitive = getDatasetValue("caseSensitive") === "true";
  var observeChanges = getDatasetValue("observe") !== "false";
  var skipInteractive = getDatasetValue("skipInteractive") !== "false";
  var maxMatches = parseInteger(getDatasetValue("maxMatches"), 0);
  var hints = [];
  var hintLookup = new Map();
  var matcher = null;
  var matchCount = 0;
  var matchedTermKeysBySection = new Map();
  var observer = null;
  var refreshTimer = null;
  var tooltip = null;
  var activeTerm = null;
  var activePreviewToken = 0;
  var pagePreviewCache = new Map();
  var hideTimer = null;

  if (csvUrl) {
    csvUrl = new URL(csvUrl, scriptUrl).toString();
  }

  injectStyles();
  bindTooltipEvents();

  var api = {
    load: load,
    refresh: refresh,
    clear: clear,
    getHints: function () {
      return hints.slice();
    }
  };

  window.HoverHints = api;

  whenReady(function () {
    load().catch(function (error) {
      console.warn("[HoverHints] " + error.message);
    });
  });

  async function load(nextCsvUrl) {
    if (nextCsvUrl) {
      csvUrl = new URL(nextCsvUrl, scriptUrl).toString();
    }

    if (!csvUrl && !csvSelector) {
      throw new Error("Missing CSV source. Add data-csv=\"https://example.com/hints.csv\" or data-csv-selector=\"#hover-hints-csv\" to the script tag.");
    }

    disconnectObserver();

    var csvText = await getCsvText();
    hints = normaliseRows(parseCsv(csvText));
    hintLookup = buildHintLookup(hints);
    matcher = buildMatcher(hints);
    clear();
    refresh();

    if (observeChanges) {
      connectObserver();
    }

    return hints;
  }

  async function getCsvText() {
    if (csvSelector) {
      var csvElement = document.querySelector(csvSelector);

      if (!csvElement) {
        throw new Error("Could not find CSV element matching " + csvSelector + ".");
      }

      return csvElement.textContent || "";
    }

    var response = await fetch(csvUrl, { credentials: "omit" });
    if (!response.ok) {
      throw new Error("Could not load hints CSV: " + response.status + " " + response.statusText);
    }

    return response.text();
  }

  function refresh(root) {
    if (!matcher || !hints.length) {
      return;
    }

    var scopeRoots = getScopeRoots();
    if (!scopeRoots.length) {
      return;
    }

    matchedTermKeysBySection = getWrappedTermKeysBySection(scopeRoots);

    var scanRoots = root ? getScopedScanRoots(root, scopeRoots) : scopeRoots;

    scanRoots.forEach(function (scanRoot) {
      var scopeRoot = getContainingScopeRoot(scanRoot, scopeRoots);

      walkTextNodes(scanRoot, function (textNode) {
        wrapTextNode(textNode, scopeRoot);
      });
    });
  }

  function clear() {
    disconnectObserver();

    unwrapTerms();
    resetMatches();

    if (observeChanges && matcher) {
      connectObserver();
    }
  }

  function unwrapTerms() {
    document.querySelectorAll(".hh-term").forEach(function (node) {
      node.replaceWith(document.createTextNode(node.textContent || ""));
    });

    if (document.body) {
      document.body.normalize();
    }
  }

  function resetMatches() {
    matchCount = 0;
    matchedTermKeysBySection = new Map();
  }

  function walkTextNodes(root, callback) {
    var walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          if (!node.nodeValue || !node.nodeValue.trim()) {
            return NodeFilter.FILTER_REJECT;
          }

          if (shouldSkipNode(node.parentElement)) {
            return NodeFilter.FILTER_REJECT;
          }

          if (!matcher.test(node.nodeValue)) {
            matcher.lastIndex = 0;
            return NodeFilter.FILTER_REJECT;
          }

          matcher.lastIndex = 0;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    var nodes = [];
    var node;

    while ((node = walker.nextNode())) {
      nodes.push(node);
    }

    nodes.forEach(callback);
  }

  function wrapTextNode(textNode, scopeRoot) {
    if (maxMatches > 0 && matchCount >= maxMatches) {
      return;
    }

    var text = textNode.nodeValue;
    var fragment = document.createDocumentFragment();
    var sectionKey = getSectionKey(textNode, scopeRoot);
    var matchedTermKeys = getSectionTermKeys(sectionKey);
    var lastIndex = 0;
    var match;

    matcher.lastIndex = 0;

    while ((match = matcher.exec(text))) {
      var matchedText = match[0];
      var termKey = getLookupKey(matchedText);
      var term = hintLookup.get(termKey);

      if (!term || matchedTermKeys.has(termKey) || isParenthesizedMatch(text, match.index, matchedText.length)) {
        continue;
      }

      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      var wrapped = document.createElement("span");
      wrapped.className = "hh-term";
      wrapped.tabIndex = 0;
      wrapped.setAttribute("aria-label", getTermAriaLabel(matchedText, term));
      wrapped.dataset.hhHint = term.hint;
      wrapped.dataset.hhHintType = term.type;
      if (term.url) {
        wrapped.dataset.hhHintUrl = term.url;
      }
      wrapped.textContent = matchedText;
      fragment.appendChild(wrapped);

      matchedTermKeys.add(termKey);
      lastIndex = match.index + matchedText.length;
      matchCount += 1;

      if (maxMatches > 0 && matchCount >= maxMatches) {
        break;
      }
    }

    if (lastIndex === 0) {
      return;
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    textNode.replaceWith(fragment);
  }

  function shouldSkipNode(element) {
    if (!element) {
      return true;
    }

    var skippedTags = "script, style, noscript, iframe, canvas, svg, textarea, input, select, option, h1, h2, h3, h4, h5, h6";
    var interactiveTags = "a, button, label, summary, [contenteditable='true']";
    var selector = skippedTags + ", .hh-term, .hh-tooltip, [data-hover-hints-skip]";

    if (skipInteractive) {
      selector += ", " + interactiveTags;
    }

    return Boolean(element.closest(selector));
  }

  function getWrappedTermKeysBySection(roots) {
    var keysBySection = new Map();

    roots.forEach(function (root) {
      var wrappedTerms = root ? root.querySelectorAll(".hh-term") : [];

      wrappedTerms.forEach(function (node) {
        var sectionKey = getSectionKey(node, root);
        var keys = keysBySection.get(sectionKey);

        if (!keys) {
          keys = new Set();
          keysBySection.set(sectionKey, keys);
        }

        keys.add(getLookupKey(node.textContent || ""));
      });
    });

    return keysBySection;
  }

  function getScopeRoots() {
    var roots = Array.prototype.slice.call(document.querySelectorAll(scopeSelector));
    return roots.length ? roots : [document.body].filter(Boolean);
  }

  function getContainingScopeRoot(node, scopeRoots) {
    var element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    var containingRoot = scopeRoots.find(function (scopeRoot) {
      return scopeRoot === element || scopeRoot.contains(element);
    });

    return containingRoot || scopeRoots[0] || document.body;
  }

  function getScopedScanRoots(root, scopeRoots) {
    var element = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;

    if (!element) {
      return [];
    }

    return scopeRoots.reduce(function (targets, scopeRoot) {
      if (scopeRoot === element || scopeRoot.contains(element)) {
        targets.push(element);
      } else if (element.contains(scopeRoot)) {
        targets.push(scopeRoot);
      }

      return targets;
    }, []);
  }

  function getSectionTermKeys(sectionKey) {
    var keys = matchedTermKeysBySection.get(sectionKey);

    if (!keys) {
      keys = new Set();
      matchedTermKeysBySection.set(sectionKey, keys);
    }

    return keys;
  }

  function getSectionKey(node, root) {
    var sectionKey = "__before_first_h1_h2_h3__";
    var headings = root ? root.querySelectorAll("h1,h2,h3") : [];

    headings.forEach(function (heading) {
      var position = heading.compareDocumentPosition(node);

      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        sectionKey = heading;
      }
    });

    return sectionKey;
  }

  function isParenthesizedMatch(text, index, length) {
    return text[index - 1] === "(" && text[index + length] === ")";
  }

  function parseCsv(csvText) {
    var rows = [];
    var row = [];
    var field = "";
    var insideQuotes = false;

    for (var index = 0; index < csvText.length; index += 1) {
      var char = csvText[index];
      var nextChar = csvText[index + 1];

      if (insideQuotes && char === "\"" && nextChar === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        insideQuotes = !insideQuotes;
      } else if (char === "," && !insideQuotes) {
        row.push(field);
        field = "";
      } else if ((char === "\n" || char === "\r") && !insideQuotes) {
        if (char === "\r" && nextChar === "\n") {
          index += 1;
        }
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += char;
      }
    }

    if (field || row.length) {
      row.push(field);
      rows.push(row);
    }

    rows = rows.filter(function (item) {
      return item.some(function (cell) {
        return cell.trim();
      });
    });

    if (!rows.length) {
      return [];
    }

    var headers = rows.shift().map(function (header) {
      return header.trim().toLowerCase();
    });

    return rows.map(function (values) {
      return headers.reduce(function (record, header, index) {
        record[header] = (values[index] || "").trim();
        return record;
      }, {});
    });
  }

  function normaliseRows(rows) {
    return rows
      .map(function (row) {
        return {
          word: row.word || row.term || row.phrase || "",
          hint: row.hint || row.tooltip || row.description || ""
        };
      })
      .filter(function (row) {
        return row.word && row.hint;
      })
      .map(function (row) {
        var url = getPageHintUrl(row.hint);
        return {
          word: row.word,
          hint: row.hint,
          type: url ? "page" : "text",
          url: url
        };
      })
      .sort(function (a, b) {
        return b.word.length - a.word.length;
      });
  }

  function getPageHintUrl(value) {
    if (!value || value.charAt(0) !== "/" || value.charAt(1) === "/") {
      return "";
    }

    var docsBase = getCurrentDocsBasePath();
    var url = new URL(docsBase ? docsBase + value : value, window.location.origin);
    return url.origin === window.location.origin ? url.toString() : "";
  }

  function getCurrentDocsBasePath() {
    var match = window.location.pathname.match(/^(.*?\/docs)(?:\/|$)/);
    return match ? match[1] : "";
  }

  function getTermAriaLabel(matchedText, term) {
    if (term.type === "page") {
      return matchedText + ": opens preview for " + term.hint;
    }

    return matchedText + ": " + term.hint;
  }

  function buildMatcher(rows) {
    var alternatives = rows.map(function (row) {
      return escapeRegExp(row.word).replace(/\s+/g, "\\s+");
    });

    var source = alternatives.join("|");

    if (wholeWord) {
      source = "(?<![\\p{L}\\p{N}_])(?:" + source + ")(?![\\p{L}\\p{N}_])";
    } else {
      source = "(?:" + source + ")";
    }

    return new RegExp(source, caseSensitive ? "gu" : "giu");
  }

  function buildHintLookup(rows) {
    var lookup = new Map();

    rows.forEach(function (row) {
      lookup.set(getLookupKey(row.word), row);
    });

    return lookup;
  }

  function getLookupKey(value) {
    var normalised = value.replace(/\s+/g, " ").trim();
    return caseSensitive ? normalised : normalised.toLowerCase();
  }

  function injectStyles() {
    if (document.getElementById("hover-hints-styles")) {
      return;
    }

    var style = document.createElement("style");
    style.id = "hover-hints-styles";
    style.textContent = [
      ".hh-term{border-bottom:1px dotted currentColor;cursor:help;position:relative;text-decoration:none}",
      ".hh-term:focus{outline:2px solid #4f46e5;outline-offset:2px}",
      ".hh-tooltip{background:#171717;border-radius:6px;box-shadow:0 10px 30px rgba(0,0,0,.18);color:#fff;font:500 13px/1.35 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;left:0;max-width:min(320px,calc(100vw - 24px));opacity:0;padding:8px 10px;pointer-events:none;position:fixed;text-align:left;top:0;transform:translateY(4px);transition:opacity .16s ease,transform .16s ease;visibility:hidden;white-space:normal;width:max-content;z-index:2147483647}",
      ".hh-tooltip[data-mode='page']{background:#fff;color:#171717;max-height:calc(100vh - 24px);max-width:min(920px,calc(100vw - 24px));padding:0;pointer-events:auto;width:auto}",
      ".hh-tooltip[data-visible='true']{opacity:1;transform:translateY(0);visibility:visible}",
      ".hh-tooltip::before{border:6px solid transparent;content:'';left:var(--hh-arrow-left,50%);position:absolute;transform:translateX(-50%)}",
      ".hh-tooltip[data-placement='top']::before{border-top-color:#171717;top:100%}",
      ".hh-tooltip[data-placement='bottom']::before{border-bottom-color:#171717;bottom:100%}",
      ".hh-tooltip[data-mode='page'][data-placement='top']::before{border-top-color:#fff}",
      ".hh-tooltip[data-mode='page'][data-placement='bottom']::before{border-bottom-color:#fff}",
      ".hh-page-close{align-items:center;background:rgba(255,255,255,.96);border:1px solid #d1d5db;border-radius:9999px;box-shadow:0 2px 8px rgba(0,0,0,.14);color:#171717;cursor:pointer;display:flex;font:700 14px/1 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;height:28px;justify-content:center;padding:0;position:absolute;right:8px;top:8px;width:28px;z-index:2}",
      ".hh-page-close:hover,.hh-page-close:focus{background:#171717;border-color:#171717;color:#fff;outline:none}",
      ".hh-page-status{align-items:center;display:flex;min-height:96px;padding:18px 20px}",
      ".hh-page-error{color:#b91c1c}",
      ".hh-page-frame{background:#fff;border:0;display:block;height:auto;max-height:calc(100vh - 48px);overflow:hidden;width:min(920px,calc(100vw - 24px))}"
    ].join("");

    document.head.appendChild(style);
  }

  function bindTooltipEvents() {
    document.addEventListener("mouseover", function (event) {
      var term = getHintTerm(event.target);
      if (term) {
        cancelHideTooltip();
        showTooltip(term);
      }
    });

    document.addEventListener("focusin", function (event) {
      var term = getHintTerm(event.target);
      if (term) {
        showTooltip(term);
      }
    });

    document.addEventListener("mouseout", function (event) {
      var term = getHintTerm(event.target);
      if (term && !term.contains(event.relatedTarget) && !isTooltipTarget(event.relatedTarget)) {
        scheduleHideTooltip(term);
      }
    });

    document.addEventListener("focusout", function (event) {
      var term = getHintTerm(event.target);
      if (term) {
        hideTooltip(term);
      }
    });

    window.addEventListener("scroll", positionTooltip, true);
    window.addEventListener("resize", positionTooltip);
  }

  function getHintTerm(target) {
    return target && target.closest ? target.closest(".hh-term") : null;
  }

  function isTooltipTarget(target) {
    return Boolean(tooltip && target && tooltip.contains(target));
  }

  function ensureTooltip() {
    if (tooltip) {
      return tooltip;
    }

    tooltip = document.createElement("div");
    tooltip.className = "hh-tooltip";
    tooltip.id = "hover-hints-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.hidden = true;
    tooltip.addEventListener("mouseenter", cancelHideTooltip);
    tooltip.addEventListener("mouseleave", function () {
      if (activeTerm && document.activeElement !== activeTerm) {
        scheduleHideTooltip(activeTerm);
      }
    });
    document.body.appendChild(tooltip);
    return tooltip;
  }

  function showTooltip(term) {
    var hint = term.dataset.hhHint;
    if (!hint) {
      return;
    }

    activeTerm = term;
    cancelHideTooltip();
    term.setAttribute("aria-describedby", "hover-hints-tooltip");

    var hintTooltip = ensureTooltip();
    var hintType = term.dataset.hhHintType || "text";
    hintTooltip.dataset.mode = hintType;
    hintTooltip.hidden = false;
    hintTooltip.dataset.visible = "false";

    if (hintType === "page") {
      showPageTooltip(term, hintTooltip);
    } else {
      activePreviewToken += 1;
      hintTooltip.textContent = hint;
      positionTooltip();
      hintTooltip.dataset.visible = "true";
    }
  }

  function showPageTooltip(term, hintTooltip) {
    var hintUrl = term.dataset.hhHintUrl;
    var previewToken = activePreviewToken + 1;
    activePreviewToken = previewToken;

    hintTooltip.textContent = "";
    positionTooltip();

    getPagePreview(hintUrl)
      .then(function (srcdoc) {
        if (previewToken !== activePreviewToken || term !== activeTerm) {
          return;
        }

        renderPageFrame(hintTooltip, srcdoc, term.textContent || "Hint preview");
      })
      .catch(function () {
        if (previewToken !== activePreviewToken || term !== activeTerm) {
          return;
        }

        renderPageStatus(hintTooltip, "Could not load preview.", true);
        positionTooltip();
        hintTooltip.dataset.visible = "true";
      });
  }

  function renderPageStatus(hintTooltip, message, isError) {
    var status = document.createElement("div");
    status.className = "hh-page-status" + (isError ? " hh-page-error" : "");
    status.textContent = message;

    hintTooltip.textContent = "";
    hintTooltip.appendChild(status);
  }

  function renderPageFrame(hintTooltip, srcdoc, title) {
    var closeButton = document.createElement("button");
    var frame = document.createElement("iframe");
    closeButton.className = "hh-page-close";
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close preview");
    closeButton.textContent = "X";
    closeButton.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      hideTooltip(activeTerm);
    });

    frame.className = "hh-page-frame";
    frame.title = title;
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.setAttribute("scrolling", "no");
    frame.addEventListener("load", function () {
      resizePageFrame(frame);
      positionTooltip();
      window.requestAnimationFrame(function () {
        hintTooltip.dataset.visible = "true";
      });
    });
    frame.srcdoc = srcdoc;

    hintTooltip.textContent = "";
    hintTooltip.appendChild(closeButton);
    hintTooltip.appendChild(frame);
  }

  function resizePageFrame(frame) {
    var frameDocument = frame.contentDocument;
    if (!frameDocument) {
      return;
    }

    var documentElement = frameDocument.documentElement;
    var body = frameDocument.body;
    var viewportWidth = document.documentElement.clientWidth;
    var viewportHeight = document.documentElement.clientHeight;
    var maxWidth = Math.min(920, viewportWidth - 24);
    var maxHeight = viewportHeight - 48;
    var contentWidth = Math.max(
      body ? body.scrollWidth : 0,
      documentElement ? documentElement.scrollWidth : 0
    );
    var contentHeight = Math.max(
      body ? body.scrollHeight : 0,
      documentElement ? documentElement.scrollHeight : 0
    );

    frame.style.width = Math.max(260, Math.min(contentWidth, maxWidth)) + "px";
    frame.style.height = Math.max(96, Math.min(contentHeight, maxHeight)) + "px";
  }

  function getPagePreview(url) {
    if (!url) {
      return Promise.reject(new Error("Missing preview URL."));
    }

    if (!pagePreviewCache.has(url)) {
      pagePreviewCache.set(url, fetch(url, { credentials: "same-origin" })
        .then(function (response) {
          if (!response.ok) {
            throw new Error("Could not load preview: " + response.status + " " + response.statusText);
          }

          return response.text();
        })
        .then(function (html) {
          return buildPagePreviewSrcdoc(html, url);
        }));
    }

    return pagePreviewCache.get(url);
  }

  function buildPagePreviewSrcdoc(html, url) {
    var parsed = new DOMParser().parseFromString(html, "text/html");
    var content = parsed.querySelector("article.rm-Article .rm-Markdown.markdown-body[data-testid='RDMD']") ||
      parsed.querySelector(".rm-Markdown.markdown-body[data-testid='RDMD']") ||
      parsed.querySelector(".rm-Markdown.markdown-body") ||
      parsed.querySelector(".markdown-body") ||
      parsed.querySelector("main") ||
      parsed.body;
    var preview = content.cloneNode(true);

    preview.querySelectorAll("script, style, link, iframe, object, embed").forEach(function (node) {
      node.remove();
    });

    preview.querySelectorAll(".lightbox-inner > img").forEach(function (image) {
      var lightbox = image.closest(".img.lightbox");
      if (lightbox) {
        var clonedImage = image.cloneNode(true);
        clonedImage.classList.add("hh-lightbox-image");
        lightbox.replaceWith(clonedImage);
      }
    });

    preview.querySelectorAll("[style]").forEach(function (node) {
      node.removeAttribute("style");
    });

    return [
      "<!doctype html>",
      "<html>",
      "<head>",
      "<base href=\"" + escapeHtml(url) + "\">",
      "<meta charset=\"utf-8\">",
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
      "<style>",
      "html{background:#fff}",
      "body{box-sizing:border-box;margin:0;padding:16px 18px;color:#171717;background:#fff;font:400 14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
      "*,::before,::after{box-sizing:inherit}",
      "body>*:first-child{margin-top:0!important}",
      "body>*:last-child{margin-bottom:0!important}",
      "p,ol,ul,table,pre,blockquote{margin-top:0;margin-bottom:12px}",
      "ol,ul{padding-left:1.35rem}",
      "li{margin:0 0 4px}",
      "ul{list-style:disc}",
      "ol{list-style:decimal}",
      "img{border:1px solid #e5e7eb;border-radius:4px;display:block;height:auto;margin:12px 0;max-height:220px;max-width:100%;object-fit:contain}",
      "img.hh-lightbox-image{height:auto;max-height:none;max-width:none;min-width:800px;width:100%}",
      "br{display:none}",
      "a{color:#831fbf;text-decoration:none}",
      "a:hover{text-decoration:underline}",
      "code,pre{background:#f6f2f8;border-radius:4px}",
      "code{padding:.12em .28em}",
      "pre{overflow:auto;padding:12px}",
      "table{border-collapse:collapse;width:100%}",
      "td,th{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}",
      "</style>",
      "</head>",
      "<body>",
      preview.innerHTML,
      "</body>",
      "</html>"
    ].join("");
  }

  function hideTooltip(term) {
    if (term && term !== activeTerm) {
      return;
    }

    if (activeTerm) {
      activeTerm.removeAttribute("aria-describedby");
    }

    activeTerm = null;
    activePreviewToken += 1;

    if (tooltip) {
      tooltip.dataset.visible = "false";
      tooltip.hidden = true;
    }
  }

  function scheduleHideTooltip(term) {
    cancelHideTooltip();
    hideTimer = window.setTimeout(function () {
      hideTimer = null;
      hideTooltip(term);
    }, 120);
  }

  function cancelHideTooltip() {
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function positionTooltip() {
    if (!activeTerm || !tooltip || tooltip.hidden) {
      return;
    }

    var margin = 10;
    var gap = 10;
    var termRect = activeTerm.getBoundingClientRect();
    var tooltipRect = tooltip.getBoundingClientRect();
    var viewportWidth = document.documentElement.clientWidth;
    var viewportHeight = document.documentElement.clientHeight;
    var preferredTop = termRect.top - tooltipRect.height - gap;
    var placement = preferredTop >= margin ? "top" : "bottom";
    var top = placement === "top" ? preferredTop : termRect.bottom + gap;

    if (top + tooltipRect.height > viewportHeight - margin) {
      top = Math.max(margin, viewportHeight - tooltipRect.height - margin);
    }

    var centeredLeft = termRect.left + (termRect.width / 2) - (tooltipRect.width / 2);
    var left = Math.min(
      Math.max(margin, centeredLeft),
      Math.max(margin, viewportWidth - tooltipRect.width - margin)
    );
    var arrowLeft = termRect.left + (termRect.width / 2) - left;

    tooltip.dataset.placement = placement;
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
    tooltip.style.setProperty(
      "--hh-arrow-left",
      Math.min(Math.max(12, arrowLeft), tooltipRect.width - 12) + "px"
    );
  }

  function connectObserver() {
    if (observer || !document.body) {
      return;
    }

    observer = new MutationObserver(function (mutations) {
      var shouldRefreshScope = false;

      mutations.forEach(function (mutation) {
        if (isHoverHintsUiNode(mutation.target)) {
          return;
        }

        if (mutation.type === "characterData" && mutation.target.parentElement) {
          refresh(mutation.target.parentElement);
          shouldRefreshScope = true;
          return;
        }

        mutation.addedNodes.forEach(function (node) {
          if (isHoverHintsUiNode(node)) {
            return;
          }

          if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
            refresh(node.parentElement);
            shouldRefreshScope = true;
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            refresh(node);
            shouldRefreshScope = true;
          }
        });
      });

      if (shouldRefreshScope) {
        scheduleRefresh();
      }
    });

    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  }

  function isHoverHintsUiNode(node) {
    var element = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
    return Boolean(element && element.closest("#hover-hints-tooltip, #hover-hints-styles, .hh-tooltip"));
  }

  function disconnectObserver() {
    if (refreshTimer) {
      window.clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) {
      window.clearTimeout(refreshTimer);
    }

    refreshTimer = window.setTimeout(function () {
      refreshTimer = null;
      rescan();
    }, 120);
  }

  function rescan() {
    disconnectObserver();
    unwrapTerms();
    resetMatches();
    refresh();

    if (observeChanges && matcher) {
      connectObserver();
    }
  }

  function getDatasetValue(name) {
    return currentScript && currentScript.dataset ? currentScript.dataset[name] : "";
  }

  function parseInteger(value, fallback) {
    var parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
      }[char];
    });
  }

  function whenReady(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  }
})();
