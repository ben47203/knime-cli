package com.ben47203.knimecli.server;

import org.osgi.framework.BundleActivator;
import org.osgi.framework.BundleContext;

/** Stops the server and removes the discovery file when the bundle stops (normal KNIME shutdown). */
public final class Activator implements BundleActivator {

    @Override
    public void start(final BundleContext context) {
        // Started from Startup#earlyStartup, once the workbench exists.
    }

    @Override
    public void stop(final BundleContext context) {
        ServerLifecycle.stop();
    }
}
