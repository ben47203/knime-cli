package com.ben47203.knimecli.server;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Map;

import com.ben47203.knimecli.server.http.Json;

/**
 * Writes {@code ~/.knime-cli/instances/<pid>.json} so clients (CLI, MCP etc - just non-KNIME runtime) 
 * can find this instance. The file holds the bearer token,
 * so it is created RW------- inside a RWX------ directory and written atomically so a client never reads a
 * partial file.
 *
 * <p>
 * Deletion on exit is best effort: a crash or SIGKILL leaves the file behind, so clients must check the PID is alive and
 * {@code /status} answers before trusting an entry.
 */
final class DiscoveryFile {

    private static final boolean POSIX = FileSystems.getDefault().supportedFileAttributeViews().contains("posix");

    private final Path m_file;

    private DiscoveryFile(final Path file) {
        m_file = file;
    }

    static Path defaultDirectory() {
        return Path.of(System.getProperty("user.home"), ".knime-cli", "instances");
    }

    static DiscoveryFile write(final Path dir, final long pid, final Map<String, ?> contents) throws IOException {
        if (POSIX) {
            Files.createDirectories(dir, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwx------"));
        } else {
            // If OS doesnt support POSIX (i.e. Windows), just create the directory normally. Untested.
            Files.createDirectories(dir);
        }
        var target = dir.resolve(pid + ".json");
        var tmp = POSIX
            ? Files.createTempFile(dir, pid + "-", ".tmp",
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
            : Files.createTempFile(dir, pid + "-", ".tmp");
        try {
            Files.writeString(tmp, Json.object(contents) + "\n", StandardCharsets.UTF_8);
            Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(tmp);
        }
        return new DiscoveryFile(target);
    }

    Path path() {
        return m_file;
    }

    void delete() {
        try {
            Files.deleteIfExists(m_file);
        } catch (IOException e) { // NOSONAR: best effort on shutdown
        }
    }
}
