package com.ben47203.knimecli.server;

import org.eclipse.ui.IStartup;

/**
 * Registered via {@code org.eclipse.ui.startup}; runs on a background thread once the workbench is up. The server
 * starts immediately but answers 503 on /rpc until the KNIME UI has initialised the gateway services.
 */
public final class Startup implements IStartup {

    @Override
    public void earlyStartup() {
        ServerLifecycle.start();
    }
}
