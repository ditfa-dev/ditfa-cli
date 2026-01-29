#!/bin/sh
# Stands in for the `ditfa` binary in tests: swallows the `app-server
# --listen stdio://` arguments the client always passes and runs the fixture.
exec "$NODE_BIN" "$FAKE_APP_SERVER"
