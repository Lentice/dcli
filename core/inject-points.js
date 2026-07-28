let _hook = null;

function maybeInject(name) {
  if (_hook) {
    _hook(name);
  }
}

function __setInjectHook(fn) {
  _hook = fn;
}

function __resetInject() {
  _hook = null;
}

module.exports = { maybeInject, __setInjectHook, __resetInject };
