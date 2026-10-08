/*
========================================================================
Speciedex.org
Terminal Settings Overlay
========================================================================

Graphical settings panel layered over the browser terminal.  It is deliberately
implemented as a client UI for the existing terminal-settings service so the
same values remain controllable from commands, profiles, and the gear button.
========================================================================
*/
(function (window, document) {
    "use strict";

    const MODULE_NAME = "SettingsUI";
    const VERSION = "1.0.0";
    const SYMBOL = Symbol.for("speciedex.terminal.settings-ui.instance");

    function settingsFor(context) {
        return context.settings || context.services?.get?.("settings") || null;
    }

    function number(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function make(tag, className, text = "") {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text) element.textContent = text;
        return element;
    }

    class SettingsOverlay {
        constructor(context) {
            this.context = context;
            this.root = context.root || document.documentElement;
            this.settings = settingsFor(context);
            this.overlay = null;
            this.inputs = new Map();
            this.knobs = new Map();
            this.abort = new AbortController();
            this.bound = false;
            this.mount();
        }

        mount() {
            if (this.root[SYMBOL]) return this.root[SYMBOL];
            const shell = this.root.querySelector("[data-terminal-shell]") || this.root;
            const overlay = make("div", "terminal-settings-overlay");
            overlay.hidden = true;
            overlay.setAttribute("role", "presentation");
            overlay.dataset.terminalSettingsOverlay = "";

            const dialog = make("section", "terminal-settings-dialog");
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");
            dialog.setAttribute("aria-labelledby", "speciedex-terminal-settings-title");

            const header = make("header", "terminal-settings-dialog-header");
            const title = make("h3", "", "Terminal Settings");
            title.id = "speciedex-terminal-settings-title";
            const close = make("button", "terminal-splash-control terminal-settings-close", "×");
            close.type = "button";
            close.title = "Close settings";
            close.setAttribute("aria-label", "Close settings");
            close.dataset.terminalSettingsClose = "";
            header.append(title, close);

            const grid = make("div", "terminal-settings-grid");
            const rangeFields = [
                ["terminalFontSize", "Font size", 10, 24, 1, "px"],
                ["terminalLineHeight", "Line height", 1, 2, .05, "×"],
                ["splashRowHeight", "Library row height", 22, 60, 1, "px"],
                ["splashVisibleRows", "Rows per random frame", 4, 256, 1, ""],
                ["splashInterval", "Frame interval", 50, 10000, 10, "ms"],
                ["wordCloudOpacity", "Word-cloud opacity", 0, 1, .01, ""],
            ];
            for (const definition of rangeFields) {
                grid.append(this.rangeField(...definition));
            }

            grid.append(this.knobField("matrixDensity", "Matrix density", .25, 1, .05, "×"));
            grid.append(this.knobField("matrixSpeed", "Matrix speed", .25, 3, .05, "×"));
            grid.append(this.selectField("terminalTheme", "Theme", ["speciedex", "dark", "high-contrast", "minimal"]));
            grid.append(this.selectField("terminalLayout", "Layout", ["standard", "compact", "wide", "fullscreen"]));
            grid.append(this.selectField("outputFormat", "Output format", ["table", "json", "list", "tree"]));
            grid.append(this.toggleField("animation", "Interface animation"));
            grid.append(this.toggleField("autoScroll", "Auto-scroll console"));
            grid.append(this.toggleField("reducedMotion", "Reduced motion"));

            const footer = make("footer", "terminal-settings-dialog-footer");
            const note = make("span", "terminal-settings-value", "Settings persist locally in this browser.");
            const buttons = make("div", "terminal-settings-dialog-header");
            const reset = make("button", "terminal-splash-control", "Reset");
            reset.type = "button";
            reset.dataset.terminalSettingsReset = "";
            const cancel = make("button", "terminal-splash-control", "Cancel");
            cancel.type = "button";
            cancel.dataset.terminalSettingsClose = "";
            const save = make("button", "terminal-splash-control", "Save");
            save.type = "button";
            save.dataset.terminalSettingsSave = "";
            buttons.append(reset, cancel, save);
            footer.append(note, buttons);

            dialog.append(header, grid, footer);
            overlay.append(dialog);
            shell.append(overlay);
            this.overlay = overlay;
            this.dialog = dialog;
            this.bind();
            this.root[SYMBOL] = this;
            return this;
        }

        fieldShell(labelText) {
            const field = make("div", "terminal-settings-field");
            const label = make("span", "terminal-settings-label", labelText);
            field.append(label);
            return field;
        }

        rangeField(name, labelText, min, max, step, suffix) {
            const field = this.fieldShell(labelText);
            const input = document.createElement("input");
            input.type = "range";
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.dataset.settingName = name;
            const value = make("span", "terminal-settings-value");
            value.dataset.settingValue = name;
            value.dataset.settingSuffix = suffix;
            input.addEventListener("input", () => {
                value.textContent = `${input.value}${suffix}`;
            }, { signal: this.abort.signal });
            this.inputs.set(name, input);
            field.append(input, value);
            return field;
        }

        knobField(name, labelText, min, max, step, suffix) {
            const field = this.fieldShell(labelText);
            const wrap = make("div", "terminal-settings-knob-wrap");
            const knob = make("div", "terminal-settings-knob");
            knob.setAttribute("aria-hidden", "true");
            const right = make("div", "");
            const input = document.createElement("input");
            input.type = "range";
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.dataset.settingName = name;
            const value = make("span", "terminal-settings-value");
            value.dataset.settingValue = name;
            value.dataset.settingSuffix = suffix;
            const update = () => {
                const ratio = (number(input.value, min) - min) / (max - min);
                knob.style.setProperty("--terminal-knob-angle", `${Math.round(ratio * 270)}deg`);
                value.textContent = `${input.value}${suffix}`;
            };
            input.addEventListener("input", update, { signal: this.abort.signal });
            this.inputs.set(name, input);
            this.knobs.set(name, update);
            right.append(input, value);
            wrap.append(knob, right);
            field.append(wrap);
            return field;
        }

        selectField(name, labelText, values) {
            const field = this.fieldShell(labelText);
            const select = document.createElement("select");
            select.dataset.settingName = name;
            for (const item of values) {
                const option = document.createElement("option");
                option.value = item;
                option.textContent = item.replace(/-/g, " ");
                select.append(option);
            }
            this.inputs.set(name, select);
            field.append(select);
            return field;
        }

        toggleField(name, labelText) {
            const field = this.fieldShell(labelText);
            const label = make("label", "terminal-settings-toggle");
            const input = document.createElement("input");
            input.type = "checkbox";
            input.dataset.settingName = name;
            const text = make("span", "", "Enabled");
            label.append(input, text);
            this.inputs.set(name, input);
            field.append(label);
            return field;
        }

        bind() {
            if (this.bound) return;
            this.bound = true;
            const signal = this.abort.signal;
            this.root.addEventListener("click", event => {
                const button = event.target?.closest?.("[data-terminal-settings-button]");
                if (button && this.root.contains(button)) {
                    event.preventDefault();
                    this.open();
                }
            }, { signal });
            this.overlay.addEventListener("click", event => {
                if (event.target === this.overlay || event.target.closest?.("[data-terminal-settings-close]")) {
                    event.preventDefault();
                    this.close();
                    return;
                }
                if (event.target.closest?.("[data-terminal-settings-save]")) {
                    event.preventDefault();
                    this.save();
                    this.close();
                    return;
                }
                if (event.target.closest?.("[data-terminal-settings-reset]")) {
                    event.preventDefault();
                    this.settings?.resetAll?.();
                    this.refresh();
                }
            }, { signal });
            document.addEventListener("keydown", event => {
                if (event.key === "Escape" && !this.overlay.hidden) this.close();
            }, { signal });
        }

        refresh() {
            for (const [name, input] of this.inputs) {
                const current = this.settings?.get?.(name);
                if (input.type === "checkbox") input.checked = Boolean(current);
                else if (current !== undefined && current !== null) input.value = String(current);
                const value = this.overlay.querySelector(`[data-setting-value="${name}"]`);
                if (value) value.textContent = `${input.value}${value.dataset.settingSuffix || ""}`;
                this.knobs.get(name)?.();
            }
        }

        save() {
            if (!this.settings) return false;
            for (const [name, input] of this.inputs) {
                const raw = input.type === "checkbox" ? input.checked : input.value;
                this.settings.set(name, raw);
            }
            const splash = this.context.terminalSplash || this.context.services?.get?.("terminal-splash");
            splash?.setVisible?.(this.settings.get("splashVisibleRows"));
            splash?.setInterval?.(this.settings.get("splashInterval"));
            splash?.matrixController?.update?.({
                density: Math.min(1, Number(this.settings.get("matrixDensity"))),
                speed: Number(this.settings.get("matrixSpeed"))
            });
            this.root.dispatchEvent(new CustomEvent("speciedex:terminal-settings-ui-saved", {
                detail: { values: this.settings.export?.() || null }
            }));
            return true;
        }

        open() {
            this.refresh();
            this.overlay.hidden = false;
            this.root.classList.add("terminal-settings-open");
            this.dialog.querySelector("input, select, button")?.focus?.();
            return true;
        }

        close() {
            this.overlay.hidden = true;
            this.root.classList.remove("terminal-settings-open");
            this.root.querySelector("[data-terminal-settings-button]")?.focus?.();
            return true;
        }

        destroy() {
            this.abort.abort();
            this.overlay?.remove();
            if (this.root[SYMBOL] === this) delete this.root[SYMBOL];
        }
    }

    function initialize(context = {}) {
        const root = context.root || document.documentElement;
        const existing = root[SYMBOL];
        if (existing) return existing;
        const controller = new SettingsOverlay(context);
        context.settingsUI = controller;
        context.registerService?.("settings-ui", controller);
        return controller;
    }

    const commands = [{
        name: "settings-ui",
        aliases: ["settings-panel"],
        category: "interface",
        description: "Open the graphical terminal settings overlay.",
        usage: "settings-ui",
        handler: ({ context }) => {
            const controller = context.settingsUI || context.services?.get?.("settings-ui");
            controller?.open?.();
            return "Settings panel opened.";
        }
    }];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        initialize,
        mount: initialize,
        init: initialize,
        commands,
        SettingsOverlay
    });

    window.SpeciedexTerminalSettingsUI = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules["settings-ui"] = api;
    window.SpeciedexTerminalModules[MODULE_NAME] = api;
    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
