(function initializeModalModule() {
"use strict";

const overlay = document.querySelector("#modalOverlay");
const dialog = document.querySelector("#modalDialog");
const titleElement = document.querySelector("#modalTitle");
const bodyElement = document.querySelector("#modalBody");
const actionsElement = document.querySelector("#modalActions");
let activeResolver = null;
let dismissible = true;

function showModal({ title, body, actions = [], canDismiss = true }) {
  closeModal(null);
  dismissible = canDismiss;
  titleElement.textContent = title;
  bodyElement.replaceChildren(typeof body === "string" ? paragraph(body) : body);
  actionsElement.replaceChildren();
  overlay.hidden = false;

  return new Promise((resolve) => {
    activeResolver = resolve;
    actions.forEach((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.className = action.className || "";
      button.disabled = Boolean(action.disabled);
      if (action.id) button.dataset.modalAction = action.id;
      button.addEventListener("click", () => {
        if (action.keepOpen) action.onClick?.(button);
        else closeModal(action.value);
      });
      actionsElement.appendChild(button);
    });
    actionsElement.querySelector("button")?.focus();
  });
}

function closeModal(value = null) {
  if (overlay.hidden) return;
  overlay.hidden = true;
  const resolver = activeResolver;
  activeResolver = null;
  resolver?.(value);
}

function dismissModal() {
  if (dismissible) closeModal(null);
}

function updateModalProgress(current, total) {
  const counter = bodyElement.querySelector(".progress-count");
  if (counter) counter.textContent = `${current} / ${total}`;
}

function setModalActionEnabled(id, enabled) {
  const button = actionsElement.querySelector(`[data-modal-action="${id}"]`);
  if (button) button.disabled = !enabled;
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function paragraph(text) {
  return createElement("p", "", text);
}

overlay.addEventListener("click", (event) => {
  if (event.target === overlay) dismissModal();
});
dialog.addEventListener("click", (event) => event.stopPropagation());

window.BarcelModal = {
  closeModal,
  createElement,
  dismissModal,
  setModalActionEnabled,
  showModal,
  updateModalProgress,
};
})();
