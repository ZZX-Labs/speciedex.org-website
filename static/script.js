"use strict";

document.addEventListener("DOMContentLoaded", async () => {
    await loadIncludes(document);
    initializeNavigation();
    initializeExternalLinks();
    initializeCurrentYear();
    initializeData();
});

async function loadIncludes(root) {
    const includeElements = Array.from(root.querySelectorAll("[data-include]"));

    await Promise.all(includeElements.map(async (element) => {
        const includeName = sanitizeIncludeName(element.dataset.include);

        if (!includeName) {
            element.removeAttribute("data-include");
            return;
        }

        try {
            const response = await fetch(`/_partials/${includeName}.html`, {
                cache: "no-cache",
                credentials: "same-origin"
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            element.innerHTML = await response.text();
            element.removeAttribute("data-include");
            await loadIncludes(element);
        } catch (error) {
            console.error(`Unable to load partial "${includeName}":`, error);
            element.innerHTML = `
                <div class="include-error" role="alert">
                    Unable to load this section.
                </div>
            `;
            element.removeAttribute("data-include");
        }
    }));
}

function sanitizeIncludeName(value) {
    if (typeof value !== "string") {
        return "";
    }

    const name = value.trim().toLowerCase();

    return /^[a-z0-9_-]+$/.test(name) ? name : "";
}

function initializeNavigation() {
    const navigation = document.querySelector(".site-nav, nav");
    const menuToggle = document.querySelector(
        ".menu-toggle, .nav-toggle, [data-nav-toggle]"
    );
    const menu = document.querySelector(
        ".nav-links, .nav-menu, [data-nav-menu]"
    );

    if (menuToggle && menu) {
        menuToggle.setAttribute("aria-expanded", "false");

        menuToggle.addEventListener("click", () => {
            const isOpen = menu.classList.toggle("open");

            menuToggle.classList.toggle("open", isOpen);
            menuToggle.setAttribute("aria-expanded", String(isOpen));
        });
    }

    const dropdownToggles = document.querySelectorAll(
        ".dropdown-toggle, [data-dropdown-toggle]"
    );

    dropdownToggles.forEach((toggle) => {
        const parent = toggle.closest(
            ".dropdown, .has-dropdown, li"
        );

        if (!parent) {
            return;
        }

        toggle.setAttribute("aria-expanded", "false");

        toggle.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();

            const isOpen = parent.classList.toggle("open");

            toggle.setAttribute("aria-expanded", String(isOpen));
            closeOtherDropdowns(parent);
        });
    });

    document.addEventListener("click", (event) => {
        if (navigation && navigation.contains(event.target)) {
            return;
        }

        closeAllDropdowns();

        if (menu && menuToggle) {
            menu.classList.remove("open");
            menuToggle.classList.remove("open");
            menuToggle.setAttribute("aria-expanded", "false");
        }
    });

    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") {
            return;
        }

        closeAllDropdowns();

        if (menu && menuToggle) {
            menu.classList.remove("open");
            menuToggle.classList.remove("open");
            menuToggle.setAttribute("aria-expanded", "false");
            menuToggle.focus();
        }
    });

    highlightCurrentNavigationLink();
}

function closeOtherDropdowns(currentDropdown) {
    document.querySelectorAll(
        ".dropdown.open, .has-dropdown.open, li.open"
    ).forEach((dropdown) => {
        if (dropdown === currentDropdown) {
            return;
        }

        dropdown.classList.remove("open");

        const toggle = dropdown.querySelector(
            ":scope > .dropdown-toggle, :scope > [data-dropdown-toggle]"
        );

        if (toggle) {
            toggle.setAttribute("aria-expanded", "false");
        }
    });
}

function closeAllDropdowns() {
    document.querySelectorAll(
        ".dropdown.open, .has-dropdown.open, li.open"
    ).forEach((dropdown) => {
        dropdown.classList.remove("open");

        const toggle = dropdown.querySelector(
            ":scope > .dropdown-toggle, :scope > [data-dropdown-toggle]"
        );

        if (toggle) {
            toggle.setAttribute("aria-expanded", "false");
        }
    });
}

function highlightCurrentNavigationLink() {
    const currentPath = normalizePath(window.location.pathname);
    const links = document.querySelectorAll(
        ".site-nav a[href], .nav-links a[href], .nav-menu a[href]"
    );

    links.forEach((link) => {
        const url = new URL(link.href, window.location.origin);

        if (url.origin !== window.location.origin) {
            return;
        }

        const linkPath = normalizePath(url.pathname);

        if (linkPath === currentPath) {
            link.classList.add("active");
            link.setAttribute("aria-current", "page");

            const parentDropdown = link.closest(
                ".dropdown, .has-dropdown"
            );

            if (parentDropdown) {
                parentDropdown.classList.add("active-branch");
            }
        }
    });
}

function normalizePath(pathname) {
    let path = pathname || "/";

    path = path.replace(/\/index\.html$/i, "/");

    if (!path.endsWith("/")) {
        path += "/";
    }

    return path;
}

function initializeExternalLinks() {
    document.querySelectorAll('a[target="_blank"]').forEach((link) => {
        const relValues = new Set(
            (link.getAttribute("rel") || "")
                .split(/\s+/)
                .filter(Boolean)
        );

        relValues.add("noopener");
        relValues.add("noreferrer");

        link.setAttribute("rel", Array.from(relValues).join(" "));
    });
}

function initializeCurrentYear() {
    const year = String(new Date().getFullYear());

    document.querySelectorAll(
        "[data-current-year], #current-year"
    ).forEach((element) => {
        element.textContent = year;
    });
}

async function initializeData() {
    await Promise.allSettled([
        loadStatistics(),
        loadReleaseData(),
        loadSystemStatus(),
        loadActivityData()
    ]);
}

async function loadStatistics() {
    const data = await fetchJSON("/static/data/statistics.json");

    if (!data) {
        setFallbackValues(STATISTIC_BINDINGS);
        return;
    }

    const values = {
        species: getNestedValue(data, ["species", "known_species"]),
        kingdoms: getNestedValue(data, ["kingdoms"]),
        phyla: getNestedValue(data, ["phyla", "phylums"]),
        classes: getNestedValue(data, ["classes"]),
        orders: getNestedValue(data, ["orders"]),
        families: getNestedValue(data, ["families"]),
        genera: getNestedValue(data, ["genera", "genus"]),
        images: getNestedValue(data, ["images"]),
        publications: getNestedValue(data, ["publications"]),
        dna: getNestedValue(data, ["dna", "dna_records", "dna_references"]),
        contributors: getNestedValue(data, ["contributors"]),
        datasets: getNestedValue(data, ["datasets"]),
        mirrors: getNestedValue(data, ["mirrors"]),
        lastUpdated: getNestedValue(
            data,
            ["last_updated", "updated_at", "lastUpdate"]
        )
    };

    setElements(
        STATISTIC_BINDINGS.species,
        formatCount(values.species)
    );
    setElements(
        STATISTIC_BINDINGS.kingdoms,
        formatCount(values.kingdoms)
    );
    setElements(
        STATISTIC_BINDINGS.phyla,
        formatCount(values.phyla)
    );
    setElements(
        STATISTIC_BINDINGS.classes,
        formatCount(values.classes)
    );
    setElements(
        STATISTIC_BINDINGS.orders,
        formatCount(values.orders)
    );
    setElements(
        STATISTIC_BINDINGS.families,
        formatCount(values.families)
    );
    setElements(
        STATISTIC_BINDINGS.genera,
        formatCount(values.genera)
    );
    setElements(
        STATISTIC_BINDINGS.images,
        formatCount(values.images)
    );
    setElements(
        STATISTIC_BINDINGS.publications,
        formatCount(values.publications)
    );
    setElements(
        STATISTIC_BINDINGS.dna,
        formatCount(values.dna)
    );
    setElements(
        STATISTIC_BINDINGS.contributors,
        formatCount(values.contributors)
    );
    setElements(
        STATISTIC_BINDINGS.datasets,
        formatCount(values.datasets)
    );
    setElements(
        STATISTIC_BINDINGS.mirrors,
        formatCount(values.mirrors)
    );
    setElements(
        STATISTIC_BINDINGS.lastUpdated,
        formatDate(values.lastUpdated)
    );
}

async function loadReleaseData() {
    const data = await fetchJSON("/static/data/releases.json");

    if (!data) {
        setFallbackValues(RELEASE_BINDINGS);
        return;
    }

    const stable = data.stable || data.latest || data;
    const testing = data.testing || {};
    const development = data.development || {};

    setElements(
        RELEASE_BINDINGS.latestVersion,
        stable.version || "Not published"
    );
    setElements(
        RELEASE_BINDINGS.releaseDate,
        formatDate(stable.date || stable.released_at)
    );
    setElements(
        RELEASE_BINDINGS.releaseChannel,
        stable.channel || "Stable"
    );
    setElements(
        RELEASE_BINDINGS.releaseStatus,
        stable.status || "Stable"
    );
    setElements(
        RELEASE_BINDINGS.stableName,
        stable.name || "SpeciedexCore"
    );
    setElements(
        RELEASE_BINDINGS.stableVersion,
        stable.version || "Not published"
    );
    setElements(
        RELEASE_BINDINGS.stableDate,
        formatDate(stable.date || stable.released_at)
    );
    setElements(
        RELEASE_BINDINGS.stableSignature,
        stable.signature_status || "Published"
    );
    setElements(
        RELEASE_BINDINGS.testingName,
        testing.name || "SpeciedexCore"
    );
    setElements(
        RELEASE_BINDINGS.testingVersion,
        testing.version || "Not published"
    );
    setElements(
        RELEASE_BINDINGS.testingDate,
        formatDate(testing.date || testing.released_at)
    );
    setElements(
        RELEASE_BINDINGS.developmentBranch,
        development.branch || "main"
    );
    setElements(
        RELEASE_BINDINGS.developmentCommit,
        development.commit || "Not available"
    );
    setElements(
        RELEASE_BINDINGS.developmentBuild,
        development.build_status || "Not available"
    );
}

async function loadSystemStatus() {
    const data = await fetchJSON("/static/data/status.json");

    if (!data) {
        return;
    }

    updateStatus(
        ["#status-website"],
        data.website
    );
    updateStatus(
        ["#status-explorer", "#explorer-status"],
        data.explorer
    );
    updateStatus(
        ["#status-api", "#api-status"],
        data.api
    );
    updateStatus(
        ["#status-network", "#network-status"],
        data.network
    );
    updateStatus(
        ["#status-database"],
        data.database
    );

    const mirrorValue = getNestedValue(
        data,
        ["mirrors", "mirror_count"]
    );

    if (mirrorValue !== null) {
        setElements(
            ["#status-mirrors", "#mirror-count"],
            formatCount(mirrorValue)
        );
    }
}

async function loadActivityData() {
    const data = await fetchJSON("/static/data/activity.json");

    if (!data) {
        setActivityFallbacks();
        return;
    }

    renderActivityList(
        "#recent-commits",
        data.commits,
        "No recent development activity."
    );
    renderActivityList(
        "#recent-species",
        data.species,
        "No recently added species."
    );
    renderActivityList(
        "#recent-research",
        data.research,
        "No recent research updates."
    );
    renderActivityList(
        "#recent-publications",
        data.publications,
        "No recent publications."
    );

    if (data.github) {
        setElements(
            ["#github-open-issues"],
            formatCount(data.github.open_issues)
        );
        setElements(
            ["#github-pull-requests"],
            formatCount(data.github.pull_requests)
        );
    }
}

function renderActivityList(selector, items, fallbackText) {
    const list = document.querySelector(selector);

    if (!list) {
        return;
    }

    list.replaceChildren();

    if (!Array.isArray(items) || items.length === 0) {
        const item = document.createElement("li");

        item.textContent = fallbackText;
        list.appendChild(item);
        return;
    }

    items.slice(0, 6).forEach((entry) => {
        const item = document.createElement("li");
        const title = typeof entry === "string"
            ? entry
            : entry.title || entry.name || entry.message || "Update";

        if (
            typeof entry === "object" &&
            entry !== null &&
            isSafeURL(entry.url)
        ) {
            const link = document.createElement("a");

            link.href = entry.url;
            link.textContent = title;
            item.appendChild(link);
        } else {
            item.textContent = title;
        }

        if (
            typeof entry === "object" &&
            entry !== null &&
            entry.date
        ) {
            const time = document.createElement("time");

            time.dateTime = entry.date;
            time.textContent = ` — ${formatDate(entry.date)}`;
            item.appendChild(time);
        }

        list.appendChild(item);
    });
}

function setActivityFallbacks() {
    const fallbacks = {
        "#recent-commits": "Development activity unavailable.",
        "#recent-species": "Recent species records unavailable.",
        "#recent-research": "Research activity unavailable.",
        "#recent-publications": "Publication activity unavailable."
    };

    Object.entries(fallbacks).forEach(([selector, text]) => {
        const list = document.querySelector(selector);

        if (!list) {
            return;
        }

        list.replaceChildren();

        const item = document.createElement("li");

        item.textContent = text;
        list.appendChild(item);
    });
}

function updateStatus(selectors, value) {
    if (value === undefined || value === null) {
        return;
    }

    const status = typeof value === "object"
        ? value.status || value.state || value.label
        : value;

    const normalizedStatus = String(status).trim().toLowerCase();
    const displayStatus = formatStatus(status);

    document.querySelectorAll(selectors.join(",")).forEach((element) => {
        element.textContent = displayStatus;
        element.classList.remove(
            "status-online",
            "status-warning",
            "status-offline",
            "status-unknown"
        );
        element.classList.add(getStatusClass(normalizedStatus));
    });
}

function getStatusClass(status) {
    if (
        ["online", "operational", "active", "current", "healthy", "verified"]
            .includes(status)
    ) {
        return "status-online";
    }

    if (
        ["degraded", "warning", "maintenance", "partial", "testing"]
            .includes(status)
    ) {
        return "status-warning";
    }

    if (
        ["offline", "outage", "failed", "unavailable", "down"]
            .includes(status)
    ) {
        return "status-offline";
    }

    return "status-unknown";
}

function formatStatus(value) {
    if (value === undefined || value === null || value === "") {
        return "Unknown";
    }

    return String(value)
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (character) => character.toUpperCase());
}

async function fetchJSON(url) {
    try {
        const response = await fetch(url, {
            cache: "no-cache",
            credentials: "same-origin",
            headers: {
                Accept: "application/json"
            }
        });

        if (!response.ok) {
            return null;
        }

        return await response.json();
    } catch (error) {
        console.warn(`Unable to load ${url}:`, error);
        return null;
    }
}

function getNestedValue(object, keys) {
    for (const key of keys) {
        const value = object?.[key];

        if (value !== undefined && value !== null && value !== "") {
            if (typeof value === "object" && "total" in value) {
                return value.total;
            }

            return value;
        }
    }

    return null;
}

function formatCount(value) {
    if (value === undefined || value === null || value === "") {
        return "Not available";
    }

    const number = Number(value);

    if (!Number.isFinite(number)) {
        return String(value);
    }

    return new Intl.NumberFormat("en-US").format(number);
}

function formatDate(value) {
    if (!value) {
        return "Not available";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric"
    }).format(date);
}

function setElements(selectors, value) {
    if (value === undefined || value === null) {
        return;
    }

    document.querySelectorAll(selectors.join(",")).forEach((element) => {
        element.textContent = value;
    });
}

function setFallbackValues(bindingGroups) {
    Object.values(bindingGroups).forEach((selectors) => {
        setElements(selectors, "Not available");
    });
}

function isSafeURL(value) {
    if (typeof value !== "string" || !value.trim()) {
        return false;
    }

    try {
        const url = new URL(value, window.location.origin);

        return ["http:", "https:"].includes(url.protocol);
    } catch {
        return false;
    }
}

const STATISTIC_BINDINGS = {
    species: [
        "#species-count",
        "#species-total"
    ],
    kingdoms: [
        "#kingdom-count",
        "#kingdom-total"
    ],
    phyla: [
        "#phylum-count",
        "#phylum-total"
    ],
    classes: [
        "#class-count",
        "#class-total"
    ],
    orders: [
        "#order-count",
        "#order-total"
    ],
    families: [
        "#family-count",
        "#family-total"
    ],
    genera: [
        "#genus-count",
        "#genus-total"
    ],
    images: [
        "#image-count",
        "#image-total"
    ],
    publications: [
        "#publication-count",
        "#publication-total"
    ],
    dna: [
        "#dna-count",
        "#dna-total"
    ],
    contributors: [
        "#contributor-count",
        "#contributor-total"
    ],
    datasets: [
        "#dataset-count",
        "#dataset-total"
    ],
    mirrors: [
        "#mirror-count",
        "#status-mirrors"
    ],
    lastUpdated: [
        "#last-update"
    ]
};

const RELEASE_BINDINGS = {
    latestVersion: [
        "#latest-version"
    ],
    releaseDate: [
        "#release-date"
    ],
    releaseChannel: [
        "#release-channel"
    ],
    releaseStatus: [
        "#release-status"
    ],
    stableName: [
        "#stable-release-name"
    ],
    stableVersion: [
        "#stable-release-version"
    ],
    stableDate: [
        "#stable-release-date"
    ],
    stableSignature: [
        "#stable-release-signature"
    ],
    testingName: [
        "#testing-release-name"
    ],
    testingVersion: [
        "#testing-release-version"
    ],
    testingDate: [
        "#testing-release-date"
    ],
    developmentBranch: [
        "#development-branch"
    ],
    developmentCommit: [
        "#development-commit"
    ],
    developmentBuild: [
        "#development-build-status"
    ]
};
