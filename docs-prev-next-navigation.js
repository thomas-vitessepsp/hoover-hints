(function () {
  "use strict";

  var NAV_ID = "docs-prev-next-navigation";
  var STYLE_ID = "docs-prev-next-navigation-styles";
  var MAX_ATTEMPTS = 24;
  var RETRY_DELAY_MS = 250;
  var descriptionCache = Object.create(null);
  var mutationTimer = null;
  var mutationObserver = null;
  var renderedSignature = "";
  var SCRIPT_VERSION = "2026-07-31-updated-before-date";

  function normaliseUrl(href) {
    try {
      var url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) {
        return null;
      }

      url.hash = "";
      url.search = "";

      var path = url.pathname.replace(/\/+$/, "");
      url.pathname = path || "/";
      return url.toString();
    } catch (error) {
      return null;
    }
  }

  function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function isElementVisible(element) {
    if (!element || !element.getClientRects().length) {
      return false;
    }

    var style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function collectNavigationContainers() {
    var selectors = [
      "aside",
      "nav",
      "[role='navigation']",
      "[class*='sidebar']",
      "[class*='Sidebar']",
      "[class*='side-nav']",
      "[class*='SideNav']",
      "[data-sidebar]",
      "[data-testid*='sidebar']"
    ];

    var seen = new Set();
    var containers = [];

    selectors.forEach(function (selector) {
      document.querySelectorAll(selector).forEach(function (element) {
        if (!seen.has(element)) {
          seen.add(element);
          containers.push(element);
        }
      });
    });

    return containers;
  }

  function getLinkDescription(anchor, title) {
    var explicit = anchor.getAttribute("data-description") || anchor.getAttribute("aria-description");
    if (explicit) {
      return cleanText(explicit);
    }

    var labelledBy = anchor.getAttribute("aria-labelledby");
    if (labelledBy) {
      var label = document.getElementById(labelledBy);
      if (label) {
        var labelledText = cleanText(label.textContent);
        if (labelledText && labelledText !== title) {
          return labelledText.replace(title, "").trim();
        }
      }
    }

    var descriptionSelectors = [
      "[data-description]",
      "[class*='description']",
      "[class*='Description']",
      "[class*='subtitle']",
      "[class*='Subtitle']",
      "small"
    ];

    for (var index = 0; index < descriptionSelectors.length; index += 1) {
      var descriptionElement = anchor.querySelector(descriptionSelectors[index]);
      var description = descriptionElement ? cleanText(descriptionElement.textContent) : "";
      if (description && description !== title) {
        return description;
      }
    }

    return "";
  }

  function getLinkTitle(anchor) {
    var title = cleanText(anchor.getAttribute("data-title")) || cleanText(anchor.getAttribute("title"));
    if (title) {
      return title;
    }

    var titleSelectors = [
      "[data-title]",
      "[class*='title']",
      "[class*='Title']",
      "[class*='label']",
      "[class*='Label']"
    ];

    for (var index = 0; index < titleSelectors.length; index += 1) {
      var titleElement = anchor.querySelector(titleSelectors[index]);
      title = cleanText(titleElement && titleElement.textContent);
      if (title) {
        return title;
      }
    }

    return cleanText(anchor.textContent);
  }

  function collectLinks(container) {
    var links = [];
    var seenUrls = new Set();

    container.querySelectorAll("a[href]").forEach(function (anchor) {
      var url = normaliseUrl(anchor.href);
      var title = getLinkTitle(anchor);

      if (!url || !title || seenUrls.has(url)) {
        return;
      }

      if (!isElementVisible(anchor)) {
        return;
      }

      seenUrls.add(url);
      links.push({
        description: getLinkDescription(anchor, title),
        element: anchor,
        title: title,
        url: url
      });
    });

    return links;
  }

  function scoreContainer(container, links) {
    if (links.length < 2) {
      return -Infinity;
    }

    var rect = container.getBoundingClientRect();
    var viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    var score = links.length * 20;

    if (rect.left <= viewportWidth * 0.45) {
      score += 80;
    }

    if (container.tagName.toLowerCase() === "aside") {
      score += 25;
    }

    if (container.closest("header, footer")) {
      score -= 120;
    }

    if (rect.left > viewportWidth * 0.65) {
      score -= 80;
    }

    return score;
  }

  function findBestNavigation() {
    var best = null;

    collectNavigationContainers().forEach(function (container) {
      var links = collectLinks(container);
      var score = scoreContainer(container, links);

      if (!best || score > best.score) {
        best = {
          container: container,
          links: links,
          score: score
        };
      }
    });

    return best && best.score > -Infinity ? best.links : [];
  }

  function findCurrentIndex(links) {
    var currentUrl = normaliseUrl(window.location.href);
    var exactIndex = links.findIndex(function (link) {
      return link.url === currentUrl;
    });

    if (exactIndex >= 0) {
      return exactIndex;
    }

    var activeIndex = links.findIndex(function (link) {
      var element = link.element;

      if (element.matches("[aria-current='page'], [aria-current='true']")) {
        return true;
      }

      return Array.prototype.some.call(element.classList, function (className) {
        return ["active", "current", "selected", "is-active"].indexOf(className.toLowerCase()) >= 0;
      });
    });

    return activeIndex;
  }

  function findMainBody() {
    var mainElements = Array.prototype.slice.call(document.querySelectorAll("main, [role='main'], article"));
    return mainElements.length ? mainElements[mainElements.length - 1] : document.body;
  }

  function isHomePage() {
    var path = window.location.pathname.replace(/\/+$/, "");
    return path === "";
  }

  function includesAnyText(value, needles) {
    var text = cleanText(value).toLowerCase();
    return needles.some(function (needle) {
      return text.indexOf(needle) >= 0;
    });
  }

  function findAncestorBlock(element, root) {
    var block = element;

    while (block && block.parentElement && block.parentElement !== root) {
      if (block.matches("section, div, aside, form, nav")) {
        return block;
      }

      block = block.parentElement;
    }

    return element;
  }

  function findSectionHeading(root, needles) {
    var headings = root.querySelectorAll("h2, h3, h4, [role='heading']");

    for (var index = 0; index < headings.length; index += 1) {
      if (includesAnyText(headings[index].textContent, needles) && isElementVisible(headings[index])) {
        return headings[index];
      }
    }

    return null;
  }

  function findUpdatedMention(root) {
    var elements = root.querySelectorAll(".UpdatedAt, .DateLine, time, p, div, span");

    for (var index = 0; index < elements.length; index += 1) {
      var element = elements[index];
      var text = cleanText(element.textContent);

      if (
        text.length <= 80 &&
        /^updated\b.*\bago$/i.test(text) &&
        isElementVisible(element)
      ) {
        return element.closest(".UpdatedAt") || element.closest(".DateLine") || element;
      }
    }

    return null;
  }

  function findFeedbackSection(root) {
    var selectors = [
      "[class*='Feedback']",
      "[class*='feedback']",
      "[class*='PageFeedback']",
      "[data-testid*='feedback']",
      "[aria-label*='feedback']"
    ];

    for (var selectorIndex = 0; selectorIndex < selectors.length; selectorIndex += 1) {
      var candidates = root.querySelectorAll(selectors[selectorIndex]);

      for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        var candidate = candidates[candidateIndex];

        if (isFeedbackCandidate(candidate)) {
          return findAncestorBlock(candidate, root);
        }
      }
    }

    var elements = root.querySelectorAll("section, div, form, p");

    for (var index = 0; index < elements.length; index += 1) {
      var element = elements[index];

      if (isFeedbackCandidate(element)) {
        return findAncestorBlock(element, root);
      }
    }

    return null;
  }

  function isFeedbackCandidate(element) {
    var text = cleanText(element.textContent);

    return (
      text.length <= 300 &&
      !element.querySelector("h1, h2, h3") &&
      isElementVisible(element) &&
      includesAnyText(text, [
        "did this page help you",
        "did you find this page useful"
      ])
    );
  }

  function findInsertionPoint(root) {
    var updatedMention = findUpdatedMention(root);

    if (updatedMention) {
      return updatedMention;
    }

    var relatedHeading = findSectionHeading(root, ["related information"]);

    if (relatedHeading) {
      return relatedHeading;
    }

    return findFeedbackSection(root);
  }

  function placeNavigation(nav) {
    var mainBody = findMainBody();
    var insertionPoint = findInsertionPoint(mainBody);

    if (insertionPoint && insertionPoint.parentNode) {
      if (nav.parentNode === insertionPoint.parentNode && nav.nextSibling === insertionPoint) {
        return;
      }

      insertionPoint.parentNode.insertBefore(nav, insertionPoint);
      return;
    }

    if (nav.parentNode === mainBody && nav.nextSibling === null) {
      return;
    }

    mainBody.appendChild(nav);
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      ".docs-page-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:48px 0 32px;padding:0;}",
      ".docs-page-nav__card{box-sizing:border-box;min-width:0;min-height:82px;border:1px solid #e4e8f0;border-radius:8px;background:#fff;color:#172033;text-decoration:none;display:flex;flex-direction:column;justify-content:center;gap:10px;padding:16px;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease;}",
      ".docs-page-nav__card:hover{border-color:#cbd5e1;box-shadow:0 8px 24px rgba(15,23,42,.08);transform:translateY(-1px);text-decoration:none;}",
      ".docs-page-nav__next{align-items:flex-end;text-align:right;}",
      ".docs-page-nav--next-only .docs-page-nav__next{grid-column:2;}",
      ".docs-page-nav__title{max-width:100%;display:flex;align-items:center;gap:6px;color:#172033;font-size:15px;font-weight:600;line-height:1.35;}",
      ".docs-page-nav__description{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#63708a;font-size:14px;line-height:1.45;}",
      ".docs-page-nav__chevron{color:#172033;font-size:22px;font-weight:400;line-height:1;}",
      "@media (max-width:720px){.docs-page-nav{grid-template-columns:1fr;}.docs-page-nav--next-only .docs-page-nav__next{grid-column:auto;}.docs-page-nav__next{align-items:flex-start;text-align:left;}}"
    ].join("");

    document.head.appendChild(style);
  }

  function createCard(link, direction) {
    var anchor = document.createElement("a");
    anchor.className = "docs-page-nav__card docs-page-nav__" + direction;
    anchor.href = link.url;
    anchor.setAttribute("aria-label", (direction === "previous" ? "Previous page: " : "Next page: ") + link.title);

    var title = document.createElement("span");
    title.className = "docs-page-nav__title";

    var leftChevron = document.createElement("span");
    leftChevron.className = "docs-page-nav__chevron";
    leftChevron.setAttribute("aria-hidden", "true");
    leftChevron.textContent = "\u2039";

    var rightChevron = document.createElement("span");
    rightChevron.className = "docs-page-nav__chevron";
    rightChevron.setAttribute("aria-hidden", "true");
    rightChevron.textContent = "\u203A";

    var label = document.createElement("span");
    label.textContent = link.title;

    if (direction === "previous") {
      title.append(leftChevron, label);
    } else {
      title.append(label, rightChevron);
    }

    var description = document.createElement("span");
    description.className = "docs-page-nav__description";
    description.textContent = link.description || "";

    anchor.append(title, description);
    return anchor;
  }

  function findPageDescription(doc) {
    var metaDescription = doc.querySelector("meta[name='description'], meta[property='og:description']");
    var description = cleanText(metaDescription && metaDescription.getAttribute("content"));

    if (description) {
      return description;
    }

    var intro = doc.querySelector("main p, [role='main'] p, article p");
    return cleanText(intro && intro.textContent);
  }

  function fillDescription(link, card) {
    var descriptionElement = card.querySelector(".docs-page-nav__description");

    if (!descriptionElement || descriptionElement.textContent) {
      return;
    }

    if (descriptionCache[link.url]) {
      descriptionElement.textContent = descriptionCache[link.url];
      return;
    }

    window.fetch(link.url, { credentials: "same-origin" })
      .then(function (response) {
        return response.ok ? response.text() : "";
      })
      .then(function (html) {
        if (!html) {
          return;
        }

        var doc = new DOMParser().parseFromString(html, "text/html");
        var description = findPageDescription(doc);
        descriptionCache[link.url] = description;
        descriptionElement.textContent = description;
      })
      .catch(function () {
        descriptionCache[link.url] = "";
      });
  }

  function renderNavigation(links, currentIndex) {
    var previous = currentIndex > 0 ? links[currentIndex - 1] : null;
    var next = currentIndex < links.length - 1 ? links[currentIndex + 1] : null;
    var signature = [
      previous ? previous.url : "",
      links[currentIndex] ? links[currentIndex].url : "",
      next ? next.url : ""
    ].join("|");

    var existingNav = document.getElementById(NAV_ID);

    if (signature === renderedSignature && existingNav) {
      placeNavigation(existingNav);
      return true;
    }

    renderedSignature = signature;

    document.querySelectorAll("#" + NAV_ID).forEach(function (element) {
      element.remove();
    });

    if (!previous && !next) {
      return true;
    }

    injectStyles();

    var nav = document.createElement("nav");
    nav.id = NAV_ID;
    nav.className = "docs-page-nav" + (!previous && next ? " docs-page-nav--next-only" : "");
    nav.setAttribute("aria-label", "Previous and next pages");

    if (previous) {
      var previousCard = createCard(previous, "previous");
      nav.appendChild(previousCard);
      fillDescription(previous, previousCard);
    }

    if (next) {
      var nextCard = createCard(next, "next");
      nav.appendChild(nextCard);
      fillDescription(next, nextCard);
    }

    placeNavigation(nav);
    return true;
  }

  function build(attempt) {
    document.documentElement.setAttribute("data-docs-prev-next-version", SCRIPT_VERSION);

    if (isHomePage()) {
      renderedSignature = "";

      document.querySelectorAll("#" + NAV_ID).forEach(function (element) {
        element.remove();
      });

      return;
    }

    var links = findBestNavigation();
    var currentIndex = findCurrentIndex(links);

    if (currentIndex >= 0) {
      renderNavigation(links, currentIndex);
      return;
    }

    if (attempt < MAX_ATTEMPTS) {
      window.setTimeout(function () {
        build(attempt + 1);
      }, RETRY_DELAY_MS);
    }
  }

  function scheduleBuild() {
    window.requestAnimationFrame(function () {
      build(0);
    });
  }

  function watchContentChanges() {
    if (!("MutationObserver" in window) || !document.body || mutationObserver) {
      return;
    }

    mutationObserver = new MutationObserver(function () {
      window.clearTimeout(mutationTimer);
      mutationTimer = window.setTimeout(scheduleBuild, 150);
    });

    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  function watchRouteChanges() {
    ["pushState", "replaceState"].forEach(function (method) {
      var original = window.history[method];

      window.history[method] = function () {
        var result = original.apply(this, arguments);
        scheduleBuild();
        return result;
      };
    });

    window.addEventListener("popstate", scheduleBuild);
    watchContentChanges();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      watchContentChanges();
      scheduleBuild();
    }, { once: true });
  } else {
    watchContentChanges();
    scheduleBuild();
  }

  watchRouteChanges();
})();
