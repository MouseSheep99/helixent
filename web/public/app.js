// @ts-nocheck
// Bootstrap entry
import "./app/state.js";
import "./app/api.js";
import "./app/session.js";
import "./app/config.js";
import "./app/prompt.js";
import "./app/skills.js";
import "./app/traces.js";
import "./app/tools.js";
import "./app/commands.js";
import "./app/output.js";
import "./app/trace-export.js";
import "./view/image-lightbox.js";
import { init } from "./app/session.js";
import { showError } from "./app/api.js";
import { initOutputTimelineLink } from "./app/link.js";
import { mountComposerController } from "./app/composer-controller.js";

initOutputTimelineLink();
mountComposerController();
init().catch((error) => showError(error.message || String(error), { scope: "ui" }));
