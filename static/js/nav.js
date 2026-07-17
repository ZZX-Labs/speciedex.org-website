"use strict";

/*
==============================================================================
Speciedex.org
Navigation Module
==============================================================================

Loaded by:

    /static/js/script.js

Responsibilities:

    • Initialize the primary navigation
    • Toggle the mobile menu
    • Open and close dropdown menus
    • Close navigation with outside clicks or Escape
    • Reset navigation when leaving the mobile breakpoint
    • Highlight the current page
==============================================================================
*/

(() => {
    const Speciedex =
        window.Speciedex =
        window.Speciedex || {};

    if (Speciedex.navigationModuleLoaded) {
        return;
    }

    Speciedex.navigationModuleLoaded = true;

    const NAV_SELECTOR =
        "[data-site-nav], .site-nav";

    const MENU_TOGGLE_SELECTOR =
        "[data-nav-toggle], .menu-toggle";

    const MENU_SELECTOR =
        "[data-nav-menu], .nav-menu";

    const DROPDOWN_SELECTOR =
        ".dropdown";

    const DROPDOWN_TOGGLE_SELECTOR =
        "[data-dropdown-toggle], .dropdown-toggle";

    const MOBILE_BREAKPOINT = 860;

    let nav = null;
    let menu = null;
    let menuToggle = null;
    let initialized = false;

    /*
    --------------------------------------------------------------------------
    Initialize navigation.
    --------------------------------------------------------------------------
    */

    function initializeNavigation() {
        const nextNav = document.querySelector(
            NAV_SELECTOR
        );

        if (!nextNav) {
            return;
        }

        if (
            initialized &&
            nextNav === nav
        ) {
            highlightCurrentPage(nav);
            return;
        }

        if (initialized) {
            destroyNavigation();
        }

        nav = nextNav;

        menuToggle = nav.querySelector(
            MENU_TOGGLE_SELECTOR
        );

        menu = nav.querySelector(
            MENU_SELECTOR
        );

        initializeMenuToggle();
        initializeDropdowns();

        document.addEventListener(
            "click",
            handleDocumentClick
        );

        document.addEventListener(
            "keydown",
            handleDocumentKeydown
        );

        window.addEventListener(
            "resize",
            handleWindowResize,
            {
                passive: true
            }
        );

        highlightCurrentPage(nav);

        initialized = true;
    }

    /*
    --------------------------------------------------------------------------
    Mobile menu.
    --------------------------------------------------------------------------
    */

    function initializeMenuToggle() {
        if (!menuToggle || !menu) {
            return;
        }

        menuToggle.setAttribute(
            "aria-expanded",
            "false"
        );

        menuToggle.addEventListener(
            "click",
            handleMenuToggleClick
        );
    }

    function handleMenuToggleClick(event) {
        event.preventDefault();

        const open =
            !menu.classList.contains("open");

        setMenuState(open);
    }

    function setMenuState(open) {
        if (!menu || !menuToggle) {
            return;
        }

        menu.classList.toggle(
            "open",
            open
        );

        menuToggle.classList.toggle(
            "open",
            open
        );

        menuToggle.setAttribute(
            "aria-expanded",
            String(open)
        );

        document.body.classList.toggle(
            "menu-open",
            open
        );

        if (!open) {
            closeDropdowns(nav);
        }
    }

    function closeMenu() {
        setMenuState(false);
    }

    /*
    --------------------------------------------------------------------------
    Dropdown menus.
    --------------------------------------------------------------------------
    */

    function initializeDropdowns() {
        if (!nav) {
            return;
        }

        nav.querySelectorAll(
            DROPDOWN_TOGGLE_SELECTOR
        ).forEach((toggle) => {
            const dropdown = toggle.closest(
                DROPDOWN_SELECTOR
            );

            if (!dropdown) {
                return;
            }

            toggle.setAttribute(
                "aria-expanded",
                "false"
            );

            toggle.addEventListener(
                "click",
                handleDropdownToggleClick
            );
        });
    }

    function handleDropdownToggleClick(event) {
        event.preventDefault();
        event.stopPropagation();

        const toggle = event.currentTarget;

        const dropdown = toggle.closest(
            DROPDOWN_SELECTOR
        );

        if (!dropdown || !nav) {
            return;
        }

        const open =
            !dropdown.classList.contains("open");

        closeDropdowns(
            nav,
            dropdown
        );

        setDropdownState(
            dropdown,
            toggle,
            open
        );
    }

    function setDropdownState(
        dropdown,
        toggle,
        open
    ) {
        dropdown.classList.toggle(
            "open",
            open
        );

        toggle.setAttribute(
            "aria-expanded",
            String(open)
        );
    }

    function closeDropdowns(
        navigation = nav,
        current = null
    ) {
        if (!navigation) {
            return;
        }

        navigation.querySelectorAll(
            `${DROPDOWN_SELECTOR}.open`
        ).forEach((dropdown) => {
            if (dropdown === current) {
                return;
            }

            dropdown.classList.remove(
                "open"
            );

            const toggle = dropdown.querySelector(
                ":scope > .dropdown-toggle, " +
                ":scope > [data-dropdown-toggle]"
            );

            toggle?.setAttribute(
                "aria-expanded",
                "false"
            );
        });
    }

    /*
    --------------------------------------------------------------------------
    Global event handlers.
    --------------------------------------------------------------------------
    */

    function handleDocumentClick(event) {
        if (!nav) {
            return;
        }

        if (nav.contains(event.target)) {
            return;
        }

        closeDropdowns(nav);
        closeMenu();
    }

    function handleDocumentKeydown(event) {
        if (event.key !== "Escape") {
            return;
        }

        closeDropdowns(nav);
        closeMenu();

        menuToggle?.focus();
    }

    function handleWindowResize() {
        if (
            window.innerWidth <=
            MOBILE_BREAKPOINT
        ) {
            return;
        }

        closeDropdowns(nav);
        closeMenu();
    }

    /*
    --------------------------------------------------------------------------
    Current-page highlighting.
    --------------------------------------------------------------------------
    */

    function highlightCurrentPage(
        navigation = nav
    ) {
        if (!navigation) {
            return;
        }

        const current = normalizePath(
            window.location.pathname
        );

        navigation.querySelectorAll(
            "a[href]"
        ).forEach((link) => {
            link.classList.remove(
                "active"
            );

            link.removeAttribute(
                "aria-current"
            );

            const url = new URL(
                link.href,
                window.location.href
            );

            if (
                url.origin !==
                window.location.origin
            ) {
                return;
            }

            if (
                normalizePath(url.pathname) !==
                current
            ) {
                return;
            }

            link.classList.add(
                "active"
            );

            link.setAttribute(
                "aria-current",
                "page"
            );

            link.closest(
                DROPDOWN_SELECTOR
            )?.classList.add(
                "active-branch"
            );
        });
    }

    function normalizePath(path) {
        let normalized = String(path)
            .replace(
                /\/index\.html$/i,
                "/"
            );

        if (!normalized.startsWith("/")) {
            normalized = `/${normalized}`;
        }

        if (
            normalized !== "/" &&
            !normalized.endsWith("/")
        ) {
            normalized = `${normalized}/`;
        }

        return normalized;
    }

    /*
    --------------------------------------------------------------------------
    Cleanup.
    --------------------------------------------------------------------------
    */

    function destroyNavigation() {
        if (!initialized) {
            return;
        }

        menuToggle?.removeEventListener(
            "click",
            handleMenuToggleClick
        );

        nav?.querySelectorAll(
            DROPDOWN_TOGGLE_SELECTOR
        ).forEach((toggle) => {
            toggle.removeEventListener(
                "click",
                handleDropdownToggleClick
            );
        });

        document.removeEventListener(
            "click",
            handleDocumentClick
        );

        document.removeEventListener(
            "keydown",
            handleDocumentKeydown
        );

        window.removeEventListener(
            "resize",
            handleWindowResize
        );

        closeDropdowns(nav);
        closeMenu();

        nav = null;
        menu = null;
        menuToggle = null;
        initialized = false;
    }

    /*
    --------------------------------------------------------------------------
    Public module API.
    --------------------------------------------------------------------------
    */

    Speciedex.initializeNavigation =
        initializeNavigation;

    Speciedex.closeDropdowns =
        closeDropdowns;

    Speciedex.closeNavigationMenu =
        closeMenu;

    Speciedex.highlightCurrentPage =
        highlightCurrentPage;

    Speciedex.normalizePath =
        normalizePath;

    Speciedex.destroyNavigation =
        destroyNavigation;
})();
