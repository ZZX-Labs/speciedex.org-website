"use strict";

document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-include]").forEach(loadPartial);
});

async function loadPartial(element) {
    const name = element.dataset.include;

    if (!/^[a-z0-9_-]+$/i.test(name)) {
        return;
    }

    try {
        const response = await fetch(`/_partials/${name}.html`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        element.innerHTML = await response.text();
        element.removeAttribute("data-include");

        element
            .querySelectorAll("[data-include]")
            .forEach(loadPartial);
    } catch (error) {
        console.error(`Unable to load ${name}:`, error);

        element.textContent = `Unable to load ${name}.`;
    }
}
