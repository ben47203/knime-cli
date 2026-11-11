package com.ben47203.knimecli.server.api;

import java.nio.charset.StandardCharsets;
import java.security.NoSuchAlgorithmException;
import java.util.List;

import org.knime.core.node.workflow.NodeContainer;
import org.knime.core.node.workflow.NodeContainerState;
import org.knime.core.node.workflow.NodeMessage;
import org.knime.core.node.workflow.WorkflowManager;

/**
 * Describes nodes for agents: a small, closed set of states instead of KNIME's internal ones, plus the message and
 * timing a user would see in the UI. Reads core getters only, so it is cheap enough to poll.
 */
final class NodeStates {

    private NodeStates() {
    }

    /** Node state as the UI's traffic light shows it, collapsed from {@link NodeContainerState}. */
    enum State {
            /** Not configured (red). */
            IDLE,
            /** Configured, ready to execute (amber). */
            CONFIGURED,
            /** Marked or queued for execution, waiting for predecessors or a thread. */
            QUEUED,
            /** Running. */
            EXECUTING,
            /** Executed (green). */
            EXECUTED,
            /** None of the above; seen only for unusual metanode state mixes. */
            HALTED
    }

    /** A node's warning or error. */
    record Message(String type, String text, String issue, List<String> resolutions) {
    }

    /**
     * What an agent needs to know about one node. {@code message} is omitted when there is none, and
     * {@code lastExecutionMs} when the node hasn't run since it was loaded or created.
     */
    record NodeState(String nodeId, String name, State state, Message message, String progressMessage,
        Long lastExecutionMs) {
    }

    static State state(final NodeContainer nc) {
        var s = nc.getNodeContainerState();
        // Order matters: waiting (marked or queued) is also "execution in progress".
        if (s.isExecuted()) {
            return State.EXECUTED;
        } else if (s.isConfigured()) {
            return State.CONFIGURED;
        } else if (s.isIdle()) {
            return State.IDLE;
        } else if (s.isWaitingToBeExecuted()) {
            return State.QUEUED;
        } else if (s.isExecutionInProgress()) {
            return State.EXECUTING;
        }
        return State.HALTED;
    }

    /** True while the node is marked, queued or executing, i.e. a wait on it isn't over yet. */
    static boolean inProgress(final NodeContainer nc) {
        return nc.getNodeContainerState().isExecutionInProgress();
    }

    /** The node's warning or error, or null if it has none. */
    static Message message(final NodeContainer nc) {
        var m = nc.getNodeMessage();
        if (m == null || m.getMessageType() == NodeMessage.Type.RESET || m.getMessage().isBlank()) {
            return null;
        }
        return new Message(m.getMessageType().name(), m.getMessage(), m.getIssue().orElse(null),
            m.getResolutions().isEmpty() ? null : List.copyOf(m.getResolutions()));
    }

    static NodeState describe(final NodeContainer nc) {
        String progress = null;
        if (inProgress(nc) && nc.getProgressMonitor() != null) {
            progress = nc.getProgressMonitor().getMessage();
        }
        Long lastMs = null;
        var timer = nc.getNodeTimer();
        if (timer != null && timer.getLastExecutionDuration() >= 0) {
            lastMs = timer.getLastExecutionDuration();
        }
        return new NodeState(NodeIds.toId(nc), nc.getName(), state(nc), message(nc),
            progress == null || progress.isBlank() ? null : progress, lastMs);
    }

    /**
     * The nodes directly inside {@code wfm}, copied under its lock: the core returns a live view of a TreeMap, which
     * isn't safe to iterate while the UI edits the workflow. The lock is held only for the copy.
     */
    @SuppressWarnings("try") // the lock is held, not used
    static List<NodeContainer> children(final WorkflowManager wfm) {
        try (var lock = wfm.lock()) {
            return List.copyOf(wfm.getNodeContainers());
        }
    }

    /**
     * Hash over ids, states and messages only, so a poller can tell "something ran, failed or was reset" apart from
     * layout edits (those change {@code contentHash} from {@code /api/workflow} instead).
     */
    static String stateHash(final List<NodeState> nodes) throws NoSuchAlgorithmException {
        var sb = new StringBuilder();
        for (var n : nodes) {
            sb.append(n.nodeId()).append('\t').append(n.state());
            if (n.message() != null) {
                sb.append('\t').append(n.message().type()).append('\t').append(n.message().text());
            }
            sb.append('\n');
        }
        return GatewayReadApi.sha256(sb.toString().getBytes(StandardCharsets.UTF_8));
    }
}
