/* Type definitions for the PISS browser shell.
 *
 * The runtime shapes are opaque Reason/JS values. They are decoded through
 * small accessors in Raw.re so the React code can stay declarative. */

type requestInit;

type timelineItem;
type artifactItem;
type permissionOption;
type sessionSnapshot;
type sessionSummary;
type workspaceSummary;
type directoryCandidate;
type configOption;
type configChoice;
type outboxItem;
type composerImage;
type browserFile;
type fileMention;
type activeMention;

type disposer = unit => unit;
