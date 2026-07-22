/*
========================================================================
Speciedex.org
Terminal ZMatrix Visualization
========================================================================

Speciedex-enhanced matrix visualization built on terminal-cmatrix.js. ZMatrix
adds taxonomic token streams, depth layers, scan pulses, record injections,
adaptive speed, and highlighted Speciedex identifiers.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/
(function (window, document) {
    "use strict";

    const MODULE_NAME = "ZMatrix";

    const DEFAULT_TOKENS = [
        "DOMAIN",
        "KINGDOM",
        "PHYLUM",
        "CLASS",
        "ORDER",
        "FAMILY",
        "GENUS",
        "SPECIES",
        "DNA",
        "RNA",
        "TAXON",
        "SPECIEDEX"
    ];

    function resolveCanvas(target) {
        if (target instanceof HTMLCanvasElement) {
            return target;
        }

        if (target instanceof Element) {
            return (
                target.querySelector("canvas") ||
                target.appendChild(
                    document.createElement("canvas")
                )
            );
        }

        throw new TypeError(
            "ZMatrix requires a canvas or container element."
        );
    }

    class ZMatrixController {
        constructor(target, options = {}) {
            this.canvas = resolveCanvas(target);
            this.options = {
                baseSpeed: 0.9,
                pulseSpeed: 0.018,
                opacity: 0.28,
                tokenOpacity: 0.72,
                maxInjectedRecords: 64,
                ...options
            };

            this.base = null;
            this.context =
                this.canvas.getContext("2d", {
                    alpha: true,
                    desynchronized: true
                });
            this.records = [];
            this.pulses = [];
            this.running = false;
            this.destroyed = false;
            this.frame = 0;
            this.animationFrame = 0;

            this.mountBase();
        }

        mountBase() {
            const cmatrix =
                window.SpeciedexTerminalCMatrix;

            if (!cmatrix?.mount) {
                throw new Error(
                    "ZMatrix requires terminal-cmatrix.js."
                );
            }

            this.base =
                cmatrix.mount(
                    this.canvas,
                    {
                        speed:
                            this.options.baseSpeed,
                        density: 0.86,
                        trail: 0.10,
                        opacity: 0.22,
                        glyphs:
                            "0123456789abcdefACGTN.:+-=/[]{}",
                        autoStart: true,
                        preferExternal: true
                    }
                );
        }

        inject(record) {
            if (!record || typeof record !== "object") {
                return;
            }

            const normalized = {
                scientific:
                    record.scientific_name ||
                    record.scientificName ||
                    record.canonical_name ||
                    record.canonicalName ||
                    record.name ||
                    "Unknown taxon",
                common:
                    record.common_name ||
                    record.commonName ||
                    record.vernacular_name ||
                    record.vernacularName ||
                    "No common name",
                id:
                    record.speciedex_id ||
                    record.speciedexId ||
                    record.id ||
                    record.key ||
                    "pending",
                created:
                    performance.now()
            };

            this.records.push(normalized);

            if (
                this.records.length >
                this.options.maxInjectedRecords
            ) {
                this.records.shift();
            }

            this.pulses.push({
                record: normalized,
                progress: 0,
                lane:
                    Math.floor(
                        Math.random() * 5
                    )
            });
        }

        drawOverlay() {
            if (!this.running || this.destroyed) {
                return;
            }

            const width =
                this.canvas.clientWidth;
            const height =
                this.canvas.clientHeight;

            this.context.save();
            this.context.textBaseline = "middle";

            for (const pulse of this.pulses) {
                pulse.progress +=
                    this.options.pulseSpeed;

                const x =
                    width *
                    Math.min(
                        1,
                        pulse.progress
                    );

                const y =
                    18 +
                    pulse.lane *
                    Math.max(
                        24,
                        height / 6
                    );

                const alpha =
                    Math.sin(
                        Math.min(
                            1,
                            pulse.progress
                        ) * Math.PI
                    );

                this.context.font =
                    "600 12px monospace";

                this.context.fillStyle =
                    `rgba(192, 214, 116, ${alpha * this.options.tokenOpacity})`;

                const text =
                    `${pulse.record.scientific}  |  ` +
                    `${pulse.record.common}  |  ` +
                    `${pulse.record.id}`;

                this.context.fillText(
                    text,
                    x - Math.min(460, text.length * 6.4),
                    y
                );

                this.context.strokeStyle =
                    `rgba(192, 214, 116, ${alpha * 0.30})`;

                this.context.beginPath();
                this.context.moveTo(
                    Math.max(0, x - 180),
                    y + 9
                );
                this.context.lineTo(
                    Math.min(width, x + 36),
                    y + 9
                );
                this.context.stroke();
            }

            this.pulses =
                this.pulses.filter(
                    pulse =>
                        pulse.progress < 1.05
                );

            if (
                this.records.length &&
                this.frame % 48 === 0
            ) {
                const record =
                    this.records[
                        this.frame %
                        this.records.length
                    ];

                this.context.font =
                    "10px monospace";
                this.context.fillStyle =
                    "rgba(192, 214, 116, 0.18)";

                const token =
                    DEFAULT_TOKENS[
                        this.frame %
                        DEFAULT_TOKENS.length
                    ];

                this.context.fillText(
                    `${token}:${record.id}`,
                    Math.random() *
                        Math.max(1, width - 180),
                    Math.random() *
                        Math.max(1, height - 16)
                );
            }

            this.context.restore();

            this.frame += 1;

            this.animationFrame =
                window.requestAnimationFrame(
                    () => this.drawOverlay()
                );
        }

        start() {
            if (this.running || this.destroyed) {
                return;
            }

            this.running = true;
            this.base?.start?.();
            this.drawOverlay();
        }

        stop() {
            this.running = false;
            this.base?.stop?.();

            if (this.animationFrame) {
                window.cancelAnimationFrame(
                    this.animationFrame
                );
            }
        }

        update(options = {}) {
            Object.assign(
                this.options,
                options
            );

            this.base?.update?.({
                speed:
                    this.options.baseSpeed
            });
        }

        destroy() {
            this.stop();
            this.base?.destroy?.();
            this.records = [];
            this.pulses = [];
            this.destroyed = true;
        }
    }

    function mount(target, options = {}) {
        const controller =
            new ZMatrixController(
                target,
                options
            );

        controller.start();

        return controller;
    }

    function render(data = [], options = {}) {
        const container =
            document.createElement("section");

        container.className =
            "terminal-visualization terminal-visualization-zmatrix";

        const canvas =
            document.createElement("canvas");

        container.appendChild(canvas);

        const controller =
            mount(canvas, options);

        for (const record of data) {
            controller.inject(record);
        }

        container.controller =
            controller;

        container.destroy = () =>
            controller.destroy();

        return container;
    }

    function initialize(context) {
        const visualization = {
            mount,
            render,
            Controller:
                ZMatrixController
        };

        context.registerVisualization?.(
            "zmatrix",
            visualization
        );

        context.registerRenderer?.(
            "zmatrix",
            visualization
        );

        context.zmatrix =
            visualization;

        return visualization;
    }

    const commands = [
        {
            name: "zmatrix",
            category: "visualization",
            description:
                "Control the enhanced Speciedex ZMatrix visualization.",
            usage: "zmatrix [start|stop|status]",
            handler: ({
                args,
                context,
                write,
                writeJSON
            }) => {
                const controller =
                    context.terminalSplash?.
                        matrixController;

                const action =
                    args[0] || "status";

                if (action === "start") {
                    controller?.start?.();
                    return write(
                        "ZMatrix visualization started.",
                        "success"
                    );
                }

                if (action === "stop") {
                    controller?.stop?.();
                    return write(
                        "ZMatrix visualization stopped.",
                        "success"
                    );
                }

                return writeJSON({
                    available: true,
                    active:
                        Boolean(controller),
                    records:
                        controller?.records?.length || 0,
                    pulses:
                        controller?.pulses?.length || 0
                });
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        ZMatrixController,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalZMatrix =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    document.dispatchEvent(
        new CustomEvent(
            "speciedex:terminal-module-available",
            {
                detail: {
                    name: MODULE_NAME,
                    module: api
                }
            }
        )
    );
})(window, document);
