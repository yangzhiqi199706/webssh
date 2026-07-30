'use strict';

function createIdleTimer(options) {
  const settings = options || {};
  const timeoutMs = Number(settings.timeoutMs);
  const schedule = settings.setTimeout || setTimeout;
  const cancelSchedule = settings.clearTimeout || clearTimeout;
  let handle = null;
  let cancelled = false;
  let fired = false;

  function clearPending() {
    if (handle === null) return;
    cancelSchedule(handle);
    handle = null;
  }

  function touch() {
    if (cancelled || fired || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    clearPending();
    handle = schedule(function () {
      handle = null;
      if (cancelled || fired) return;
      fired = true;
      if (typeof settings.onIdle === 'function') settings.onIdle();
    }, timeoutMs);
  }

  function cancel() {
    cancelled = true;
    clearPending();
  }

  return {
    touch,
    cancel,
  };
}

module.exports = {
  createIdleTimer,
};
