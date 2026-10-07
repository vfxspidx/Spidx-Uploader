/* ========================================================================
 *  Spidx Uploader — VEGAS Pro Application Extension
 *
 *  Speaks the exact same protocol as the Photoshop/After Effects panels —
 *  the same small files inside App\incoming that Spider Engine already
 *  reads/writes (.batch-config.json, .batch-status.json,
 *  .engine-status.json, .default-camera-raw-preset.json,
 *  .batch-force-send, .batch-cancel).
 *
 *  Visually, every color/radius/spacing/font-size constant below is taken
 *  straight from the AE panel's HTML (panel-ae.html: CSS custom
 *  properties --bg, --surface, --accent, etc., plus its px sizes) — not
 *  approximated. The layout is fluid: it fills whatever width the dock has. WinForms can't do everything CSS can (no native
 *  letter-spacing, no CSS gradients beyond what LinearGradientBrush
 *  covers), but colors, translucent rgba() backgrounds (GDI+ handles
 *  alpha fine), border radii, and the segmented-control look are all
 *  reproduced from the real values, not guessed.
 *
 *  Two upload routes, matching server.js's needsCameraRaw():
 *    - "Upload"             -> plain "<stamp>.png"    -> uploads direct
 *    - "Photoshop + Upload" -> "<stamp>.ps.png"        -> routed through
 *      the Dashboard-configured Camera Raw Action first (requires
 *      Photoshop already open). Disabled until a preset actually exists.
 *
 *  BUILD: run build.bat next to this file (csc.exe, no Visual Studio
 *  needed). INSTALL: copy the resulting SpidxUploader.dll into VEGAS's
 *  "Application Extensions" folder and restart VEGAS — see README.txt.
 *
 *  ------------------------------------------------------------------
 *  Same honesty note as always: written against VEGAS's published
 *  Application Extension API and the real CEP-AE CSS/JS as reference,
 *  but never compiled or run inside a real VEGAS install here. Every
 *  round so far has needed one real fix after an actual compile/run —
 *  expect that pattern to continue; paste back the exact error (or, for
 *  runtime issues, whatever the "Spidx Uploader — diagnostic" dialog
 *  shows) rather than describing the symptom only.
 *  ------------------------------------------------------------------
 * ==================================================================== */

using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using ScriptPortal.Vegas; // VEGAS Pro 23 confirmed — older installs may need `using Sony.Vegas;` instead

public class SpidxUploaderModule : ICustomCommandModule
{
    /* ------------------------------------------------------------------ */
    /*  Protocol constants — must match server.js / client/index.js       */
    /* ------------------------------------------------------------------ */
    // Vegas's own status bar shows this key for whichever dock view has
    // focus — it's not just an internal identifier, it's user-visible, so
    // it needs to read like a name, not a .NET class name.
    private const string DockViewName = "Spidx Uploader";
    private const string OwnConfigFileName = "vegas-panel-config.json";
    private const string BatchConfigName = ".batch-config.json";
    private const string BatchStatusName = ".batch-status.json";
    private const string EngineStatusName = ".engine-status.json";
    private const string CameraRawPresetName = ".default-camera-raw-preset.json";
    private const string BatchForceSendName = ".batch-force-send";
    private const string BatchCancelName = ".batch-cancel";
    private const int PollIntervalMs = 1500;
    private const long EngineStaleMs = 2 * 60 * 1000;
    private static readonly string[] MultiBatchTiers = { "pro", "dev", "tester" };

    private Vegas myVegas;
    private CustomCommand myViewCommand;
    private Timer myPollTimer;
    private string myIncomingFolder;

    /* UI refs */
    private Panel myRoot;
    private FlowLayoutPanel myStack;
    private int myW = 360;              // current content width (dock width - 2*13px padding)
    private bool myWidthApplied;
    private bool myLayingOut;

    private Panel myHeaderRow;
    private SpidxBrandMark myMark;
    private SpidxLabel myTitleLabel;
    private SpidxBadge myTierBadge;
    private SpidxCard myWarnBox;
    private SpidxLabel myWarnText;
    private SpidxCard myStatusCard;
    private SpidxLabel myCardTitle;
    private SpidxLabel myCardSub;
    private SpidxProgressBar myProgressBar;
    private SpidxLabel myFilesLabel;
    private Panel myBatchRow;
    private Panel myFolderNameRow;
    private SpidxLabel myFolderNameLabel;
    private SpidxInput myFolderNameInput;
    private SpidxSegButton[] myBatchButtons;
    private Panel mySendRow;
    private SpidxButton mySendButton;
    private SpidxButton myPsUploadButton;
    private SpidxLabel myRouteLineLabel;
    private SpidxCard myFileRow;
    private SpidxBadge myFileThumb;
    private SpidxLabel myFileName;
    private SpidxLabel myFileSize;
    private Panel myBatchProgressPanel;
    private SpidxBatchDots myBatchDots;
    private SpidxLabel myBatchProgressText;
    private SpidxButton mySendNowButton;
    private SpidxButton myCancelButton;
    private Panel myFooterRow;
    private SpidxLabel myChangeFolderLink;
    private SpidxLabel myFolderPathLabel;

    /* Tabs + Leaderboard tab UI refs */
    private Panel myTabsRow;
    private SpidxButton myTabUploaderBtn;
    private SpidxButton myTabLeaderboardBtn;
    private Control myUploaderPage;
    private Control myLeaderboardPage;
    private Panel myLbRow;
    private SpidxLabel myLbRegionLabel;
    private SpidxSelect myLbRegion;
    private SpidxInput myLbSearch;
    private SpidxButton myLbRefreshBtn;
    private SpidxLabel myLbStatus;
    private SpidxLbList myLbList;
    private Panel myLbBtnRow;
    private SpidxButton myLbCopyBtn;
    private SpidxLabel myLbMessage;

    /* State — mirrors client/index.js's module-level vars */
    private int mySelectedBatchCount = 1;
    private string myFolderNameValue = "";
    private string myCurrentTier;
    private string myCurrentDestination = "workupload";
    private bool myCurrentDeviceLimitReached;
    private string myLastBatchState;
    private bool myBusy;
    private bool? myEngineOnline;

    /* Leaderboard state — mirrors client/index.js's lb* vars */
    private const string LbApiHost = "http://169.58.221.14:8080";
    private const string LbCacheName = ".leaderboard-cache.json";
    private List<Dictionary<string, object>> myLbPlayers = new List<Dictionary<string, object>>();
    private int myLbSelectedIndex = -1;
    private bool myLbLoadedOnce;
    private Timer myLbSearchTimer;
    private WebClient myLbWebClient;

    /* ------------------------------------------------------------------ *
     *  ICustomCommandModule
     * ------------------------------------------------------------------ */
    public void InitializeModule(Vegas vegas)
    {
        myVegas = vegas;
    }

    public ICollection GetCustomCommands()
    {
        try
        {
            myViewCommand = new CustomCommand(CommandCategory.View, "SpidxUploaderPanel");
            myViewCommand.DisplayName = "Spidx Uploader";
            myViewCommand.Invoked += HandleInvoked;
            myViewCommand.MenuPopup += HandleMenuPopup;
            return new CustomCommand[] { myViewCommand };
        }
        catch (Exception ex)
        {
            ShowDiagnostic("GetCustomCommands (registering the menu entry)", ex);
            return new CustomCommand[0];
        }
    }

    private void HandleMenuPopup(object sender, EventArgs args)
    {
        myViewCommand.Checked = myVegas.FindDockView(DockViewName);
    }

    private void HandleInvoked(object sender, EventArgs args)
    {
        try
        {
            HandleInvokedCore();
        }
        catch (Exception ex)
        {
            ShowDiagnostic("HandleInvoked (opening/building the panel)", ex);
        }
    }

    private void ShowDiagnostic(string where, Exception ex)
    {
        MessageBox.Show(
            "Spidx Uploader hit an error in: " + where + "\n\n"
            + ex.GetType().FullName + ": " + ex.Message + "\n\n"
            + "Stack trace:\n" + ex.StackTrace,
            "Spidx Uploader — diagnostic", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    /* ------------------------------------------------------------------ *
     *  Panel construction — layout order, sizes and margins follow the
     *  AE panel's HTML/CSS (panel-ae.html):
     *    .panel (padding 12/13/16) > .hdr, .tabs, .tab-page#tabUploader
     *    (.warn-box, .card, .prog-track, .label+.seg, .hidden-row,
     *    .btn-row, route line, .file-row, .batch-progress, .foot) and
     *    .tab-page#tabLeaderboard (.lb-row, .lb-search, status, .lb-table,
     *    .btn-row, message).
     *  Width is FLUID: everything is laid out from myW (the dock's current
     *  content width), like the HTML panel which just fills its container.
     * ------------------------------------------------------------------ */
    private const int PanelPadX = 13;
    private const int MinContentW = 120;

    private void HandleInvokedCore()
    {
        if (myVegas.ActivateDockView(DockViewName)) return;

        LoadPanelConfig();

        DockableControl dockView = new DockableControl(DockViewName);
        dockView.PersistDockWindowState = true;
        dockView.AutoLoadCommand = myViewCommand;
        dockView.Text = "Spidx Uploader";

        Panel root = new Panel();
        root.Dock = DockStyle.Fill;
        root.BackColor = Sx.Bg;
        root.AutoScroll = true;
        myRoot = root;

        FlowLayoutPanel stack = new FlowLayoutPanel();
        stack.FlowDirection = FlowDirection.TopDown;
        stack.WrapContents = false;
        stack.AutoSize = true;
        stack.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        stack.BackColor = Sx.Bg;
        stack.Margin = new Padding(0);
        stack.Padding = new Padding(S(PanelPadX), S(12), S(PanelPadX), S(16));
        myStack = stack;

        stack.Controls.Add(BuildHeaderRow());
        stack.Controls.Add(BuildTabsRow());
        stack.Controls.Add(BuildUploaderPage());
        stack.Controls.Add(BuildLeaderboardPage());

        root.Controls.Add(stack);
        dockView.Controls.Add(root);
        root.SizeChanged += (s, e) => ApplyWidth();
        myVegas.LoadDockView(dockView);

        UpdateFolderLabel();
        SetBatchControlsLocked(false);
        SetSelectedBatchCount(mySelectedBatchCount, false);
        SwitchTab(false);
        ApplyWidth();

        SetCard(string.IsNullOrEmpty(myIncomingFolder) ? "Link the incoming folder" : "Ready",
            string.IsNullOrEmpty(myIncomingFolder) ? "Click \"Change incoming folder\" below and pick App\\incoming." : "Open a project and hit Upload.",
            CardState.Normal);

        StartPolling();
        dockView.Disposed += (s, e) => StopPolling();
    }

    /* -- fluid width: re-lay-out every row for the dock's current width -- */
    private void ApplyWidth()
    {
        if (myRoot == null || myLayingOut) return;
        int w = Math.Max(S(MinContentW), myRoot.ClientSize.Width - 2 * S(PanelPadX));
        if (w == myW && myWidthApplied) return;

        myLayingOut = true;
        try
        {
            if (myLbRegion != null) myLbRegion.CloseDropDown();
            myW = w;
            myWidthApplied = true;
            myStack.SuspendLayout();
            LayoutHeader();
            LayoutTabs();
            LayoutUploaderPage();
            LayoutLeaderboardPage();
            myStack.ResumeLayout(true);
        }
        finally
        {
            myLayingOut = false;
        }
    }

    private static int S(int v) { return Sx.S(v); }

    private static Padding M(int top, int bottom)
    {
        return new Padding(0, S(top), 0, S(bottom));
    }

    private static Panel NewRow(Padding margin)
    {
        return new Panel { BackColor = Sx.Bg, Margin = margin, Padding = new Padding(0) };
    }

    private static FlowLayoutPanel NewPage()
    {
        FlowLayoutPanel page = new FlowLayoutPanel();
        page.FlowDirection = FlowDirection.TopDown;
        page.WrapContents = false;
        page.AutoSize = true;
        page.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        page.BackColor = Sx.Bg;
        page.Margin = new Padding(0);
        page.Padding = new Padding(0);
        return page;
    }

    /* -- .hdr: mark (22px) + title (13px/600) + tier badge, margin-bottom 11 -- */
    private Control BuildHeaderRow()
    {
        myHeaderRow = NewRow(M(0, 11));
        myMark = new SpidxBrandMark { Size = new Size(S(22), S(22)) };
        myTitleLabel = new SpidxLabel { Text = "Spidx Uploader", ForeColor = Sx.Text, Wrap = false, Ellipsis = true };
        myTitleLabel.SetFont(13f, 600);
        myTierBadge = new SpidxBadge { Visible = false };
        myHeaderRow.Controls.Add(myMark);
        myHeaderRow.Controls.Add(myTitleLabel);
        myHeaderRow.Controls.Add(myTierBadge);
        return myHeaderRow;
    }

    private void LayoutHeader()
    {
        myHeaderRow.Size = new Size(myW, S(22));
        myMark.Location = new Point(0, 0);
        int badgeW = myTierBadge.Visible ? myTierBadge.PreferredWidth() : 0;
        if (myTierBadge.Visible)
        {
            myTierBadge.Size = new Size(badgeW, S(18));
            myTierBadge.Location = new Point(myW - badgeW, S(2));
        }
        int titleX = S(22) + S(7);
        int titleW = Math.Max(20, myW - titleX - (badgeW > 0 ? badgeW + S(7) : 0));
        int th = myTitleLabel.LineHeight();
        myTitleLabel.SetBounds(titleX, Math.Max(0, (S(22) - th) / 2), titleW, th);
    }

    /* -- .tabs: Uploader / Leaderboard, gap 6, margin-bottom 12 -- */
    private Control BuildTabsRow()
    {
        myTabsRow = NewRow(M(0, 12));
        myTabUploaderBtn = new SpidxButton { Text = "Uploader", Kind = SpidxBtnKind.Tab, IsActive = true };
        myTabLeaderboardBtn = new SpidxButton { Text = "Leaderboard", Kind = SpidxBtnKind.Tab, IsActive = false };
        myTabUploaderBtn.Click += (s, e) => SwitchTab(false);
        myTabLeaderboardBtn.Click += (s, e) => SwitchTab(true);
        myTabsRow.Controls.Add(myTabUploaderBtn);
        myTabsRow.Controls.Add(myTabLeaderboardBtn);
        return myTabsRow;
    }

    private void LayoutTabs()
    {
        int h = S(31);
        myTabsRow.Size = new Size(myW, h);
        int w1 = (myW - S(6)) / 2;
        myTabUploaderBtn.SetBounds(0, 0, w1, h);
        myTabLeaderboardBtn.SetBounds(w1 + S(6), 0, myW - w1 - S(6), h);
    }

    private void SwitchTab(bool leaderboard)
    {
        if (myLbRegion != null) myLbRegion.CloseDropDown();
        myTabUploaderBtn.IsActive = !leaderboard;
        myTabLeaderboardBtn.IsActive = leaderboard;
        myTabUploaderBtn.Invalidate();
        myTabLeaderboardBtn.Invalidate();
        myUploaderPage.Visible = !leaderboard;
        myLeaderboardPage.Visible = leaderboard;
        if (leaderboard && !myLbLoadedOnce) LbLoad();
        RefreshAll();
    }

    // After any height change (tab switch, list rows) force a full repaint so no
    // pixels of the previous layout stay behind.
    private void RefreshAll()
    {
        if (myStack == null) return;
        myStack.PerformLayout();
        myRoot.Invalidate(true);
        myStack.Invalidate(true);
    }

    /* -- .tab-page#tabUploader -- */
    private Control BuildUploaderPage()
    {
        FlowLayoutPanel page = NewPage();
        myUploaderPage = page;

        page.Controls.Add(BuildWarnBox());
        page.Controls.Add(BuildStatusCard());

        // .prog-track { margin: 10px 0 8px } — the 8px collapses into .label's 14px top margin
        myProgressBar = new SpidxProgressBar { Height = S(5), Margin = M(10, 0) };
        page.Controls.Add(myProgressBar);

        myFilesLabel = BuildSectionLabel("FILES PER UPLOAD", M(14, 6));
        page.Controls.Add(myFilesLabel);
        page.Controls.Add(BuildBatchRow());
        page.Controls.Add(BuildFolderNameRow());
        page.Controls.Add(BuildSendButtons());
        page.Controls.Add(BuildFileRow());
        page.Controls.Add(BuildBatchProgressPanel());
        page.Controls.Add(BuildFooter());
        return page;
    }

    private void LayoutUploaderPage()
    {
        // warn-box
        int warnInner = myW - 2 - 2 * S(10);
        int warnH = myWarnText.HeightFor(warnInner);
        myWarnText.SetBounds(S(10) + 1, S(8) + 1, warnInner, warnH);
        myWarnBox.Size = new Size(myW, warnH + 2 * S(8) + 2);

        FitStatusCard();
        myProgressBar.Width = myW;
        myFilesLabel.Size = new Size(myW, myFilesLabel.LineHeight());

        // .seg — 3 equal buttons, gap 6
        int segH = S(31);
        myBatchRow.Size = new Size(myW, segH);
        int segW = (myW - 2 * S(6)) / 3;
        for (int i = 0; i < 3; i++)
        {
            int x = i * (segW + S(6));
            int w = i == 2 ? myW - x : segW;
            myBatchButtons[i].SetBounds(x, 0, w, segH);
        }

        // .hidden-row
        int lblH = myFolderNameLabel.LineHeight();
        myFolderNameLabel.SetBounds(0, S(14), myW, lblH);
        int inputY = S(14) + lblH + S(6);
        myFolderNameInput.SetBounds(0, inputY, myW, S(30));
        myFolderNameRow.Size = new Size(myW, inputY + S(30));

        // .btn-row — two buttons, gap 8
        int btnH = S(42);
        mySendRow.Size = new Size(myW, btnH);
        int bw = (myW - S(8)) / 2;
        mySendButton.SetBounds(0, 0, bw, btnH);
        myPsUploadButton.SetBounds(bw + S(8), 0, myW - bw - S(8), btnH);

        myRouteLineLabel.Width = myW;
        myRouteLineLabel.Refit();

        // .file-row
        int rowH = S(50);
        myFileRow.Size = new Size(myW, rowH);
        int thumb = S(30);
        myFileThumb.SetBounds(S(10), (rowH - thumb) / 2, thumb, thumb);
        int textX = S(10) + thumb + S(9);
        int nameW = Math.Max(20, myW - textX - S(11));
        int nameH = myFileName.LineHeight();
        int sizeH = myFileSize.LineHeight();
        int blockH = nameH + S(2) + sizeH;
        int top = (rowH - blockH) / 2;
        myFileName.SetBounds(textX, top, nameW, nameH);
        myFileSize.SetBounds(textX, top + nameH + S(2), nameW, sizeH);

        // .batch-progress
        int dotsH = S(8);
        int textH = myBatchProgressText.LineHeight();
        int actH = S(31);
        int y2 = dotsH + S(7);
        int y3 = y2 + textH + S(8);
        myBatchProgressPanel.Size = new Size(myW, y3 + actH);
        myBatchDots.SetBounds(0, 0, myW, dotsH);
        myBatchProgressText.SetBounds(0, y2, myW, textH);
        int actW = (myW - S(6)) / 2;
        mySendNowButton.SetBounds(0, y3, actW, actH);
        myCancelButton.SetBounds(actW + S(6), y3, myW - actW - S(6), actH);

        // .foot
        LayoutFooter();
    }

    /* -- .tab-page#tabLeaderboard -- */
    private Control BuildLeaderboardPage()
    {
        FlowLayoutPanel page = NewPage();
        page.Visible = false;
        myLeaderboardPage = page;

        // .lb-row: "Region" label + select (flex 1) + Refresh, gap 8, margin-bottom 8
        myLbRow = NewRow(M(0, 8));
        myLbRegionLabel = new SpidxLabel { Text = "Region", Wrap = false };
        myLbRegionLabel.SetFont(11f, 400);
        myLbRegion = new SpidxSelect();
        myLbRegion.Host = myRoot;
        myLbRegion.SetItems("All", "EU", "NAC");
        myLbRegion.SelectedIndex = 0;
        myLbRegion.SelectedIndexChanged += (s, e) => LbLoad();
        myLbRefreshBtn = new SpidxButton { Text = "Refresh", Kind = SpidxBtnKind.Toolbar };
        myLbRefreshBtn.Click += (s, e) => LbLoad();
        myLbRow.Controls.Add(myLbRegionLabel);
        myLbRow.Controls.Add(myLbRegion);
        myLbRow.Controls.Add(myLbRefreshBtn);
        page.Controls.Add(myLbRow);

        // .lb-search, margin-bottom 8
        myLbSearch = new SpidxInput { Cue = "Search nick...", Margin = M(0, 8) };
        myLbSearch.TextChanged += (s, e) =>
        {
            if (myLbSearchTimer != null) { myLbSearchTimer.Stop(); myLbSearchTimer.Dispose(); }
            myLbSearchTimer = new Timer { Interval = 400 };
            myLbSearchTimer.Tick += (s2, e2) => { myLbSearchTimer.Stop(); LbLoad(); };
            myLbSearchTimer.Start();
        };
        page.Controls.Add(myLbSearch);

        // #lbStatus (.card-sub)
        myLbStatus = new SpidxLabel { Text = "Connecting...", AutoFit = true, Margin = M(0, 0) };
        myLbStatus.SetFont(10.5f, 400);
        page.Controls.Add(myLbStatus);

        // .lb-table, margin 8px 0
        myLbList = new SpidxLbList { Margin = M(8, 0) };
        myLbList.SelectedIndexChanged += (s, e) =>
        {
            myLbSelectedIndex = myLbList.SelectedIndex;
            myLbMessage.Text = "";
            myLbCopyBtn.Enabled = myLbSelectedIndex >= 0;
        };
        page.Controls.Add(myLbList);

        // .btn-row: Copy Nick (secondary, full width), margin-top 14
        myLbBtnRow = NewRow(M(14, 0));
        myLbCopyBtn = new SpidxButton { Text = "Copy Nick", Kind = SpidxBtnKind.Secondary, Enabled = false };
        myLbCopyBtn.Click += (s, e) => LbCopyNick();
        myLbBtnRow.Controls.Add(myLbCopyBtn);
        page.Controls.Add(myLbBtnRow);

        // #lbMessage (.card-sub), margin-top 4
        myLbMessage = new SpidxLabel { Text = "", AutoFit = true, HideWhenEmpty = true, Margin = M(4, 0) };
        myLbMessage.SetFont(10.5f, 400);
        page.Controls.Add(myLbMessage);

        return page;
    }

    private void LayoutLeaderboardPage()
    {
        int rowH = S(29);
        myLbRow.Size = new Size(myW, rowH);
        int labelW = myLbRegionLabel.PreferredWidth();
        int labelH = myLbRegionLabel.LineHeight();
        myLbRegionLabel.SetBounds(0, (rowH - labelH) / 2, labelW, labelH);
        int refreshW = TextRenderer.MeasureText("Refresh", Sx.Fnt(11f, 400), new Size(1000, 100), TextFormatFlags.NoPadding | TextFormatFlags.SingleLine).Width + 2 * S(11);
        myLbRefreshBtn.SetBounds(myW - refreshW, 0, refreshW, rowH);
        int selectX = labelW + S(8);
        myLbRegion.SetBounds(selectX, 0, Math.Max(40, myW - selectX - S(8) - refreshW), rowH);

        myLbSearch.Size = new Size(myW, S(31));
        myLbStatus.Width = myW;
        myLbStatus.Refit();
        myLbList.Width = myW;

        int btnH = S(42);
        myLbBtnRow.Size = new Size(myW, btnH);
        myLbCopyBtn.SetBounds(0, 0, myW, btnH);

        myLbMessage.Width = myW;
        myLbMessage.Refit();
    }

    /* -- .warn-box: device limit warning, amber tint, hidden by default -- */
    private Control BuildWarnBox()
    {
        myWarnBox = new SpidxCard(CardKind.Warn) { Radius = 9, Visible = false, Margin = M(0, 10) };
        myWarnText = new SpidxLabel
        {
            Text = "Device limit reached \u2014 this computer counts as a 3rd device on a paid tier, so it runs as Free here.",
            ForeColor = Sx.WarnText
        };
        myWarnText.SetFont(10.5f, 400);
        myWarnBox.Controls.Add(myWarnText);
        return myWarnBox;
    }

    /* -- .card: status title (12.5px/600) + sub (10.5px), centered -- */
    private Control BuildStatusCard()
    {
        myStatusCard = new SpidxCard(CardKind.Status) { Margin = M(0, 0) };
        myCardTitle = new SpidxLabel { Text = "Ready", ForeColor = Sx.Text, Center = true, Wrap = false, Ellipsis = true };
        myCardTitle.SetFont(12.5f, 600);
        myCardSub = new SpidxLabel { Text = "", Center = true };
        myCardSub.SetFont(10.5f, 400);
        myStatusCard.Controls.Add(myCardTitle);
        myStatusCard.Controls.Add(myCardSub);
        return myStatusCard;
    }

    // card: 1px border + 12px padding; title 17px line, 4px gap, sub wraps
    private void FitStatusCard()
    {
        if (myStatusCard == null || myW <= 0) return;
        int pad = S(12) + 1;
        int inner = myW - 2 * pad;
        int titleH = myCardTitle.LineHeight();
        int subH = myCardSub.HeightFor(inner);
        myCardTitle.SetBounds(pad, pad, inner, titleH);
        myCardSub.SetBounds(pad, pad + titleH + S(4), inner, subH);
        myStatusCard.Size = new Size(myW, pad + titleH + S(4) + subH + pad);
    }

    /* -- .label: 9.5px / 700 / uppercase / letter-spacing .08em / faint -- */
    private SpidxLabel BuildSectionLabel(string text, Padding margin)
    {
        SpidxLabel label = new SpidxLabel { Text = text, ForeColor = Sx.Faint, Tracking = 0.76f * Sx.K, Wrap = false, Margin = margin };
        label.SetFont(9.5f, 700);
        return label;
    }

    /* -- .seg: batch count 1/2/3, gap 6 -- */
    private Control BuildBatchRow()
    {
        myBatchRow = NewRow(M(0, 0));
        myBatchButtons = new SpidxSegButton[3];
        for (int i = 0; i < 3; i++)
        {
            int count = i + 1;
            SpidxSegButton btn = new SpidxSegButton { Text = count.ToString() };
            int captured = count;
            btn.Click += (s, e) => SetSelectedBatchCount(captured, true);
            myBatchRow.Controls.Add(btn);
            myBatchButtons[i] = btn;
        }
        return myBatchRow;
    }

    /* -- .hidden-row: folder name, only for Drive + batch > 1 -- */
    private Control BuildFolderNameRow()
    {
        myFolderNameRow = NewRow(M(0, 0));
        myFolderNameRow.Visible = false;
        myFolderNameLabel = BuildSectionLabel("CLIENT / PROJECT NAME", M(0, 0));
        myFolderNameInput = new SpidxInput { Text = myFolderNameValue, Cue = "Drive subfolder name" };
        myFolderNameInput.TextChanged += (s, e) => { myFolderNameValue = myFolderNameInput.Text; SavePanelConfig(); };
        myFolderNameRow.Controls.Add(myFolderNameLabel);
        myFolderNameRow.Controls.Add(myFolderNameInput);
        return myFolderNameRow;
    }

    /* -- .btn-row: Upload (primary) + Photoshop + Upload (secondary), side by side, margin-top 14,
          then the route line (.card-sub, margin-top 6) -- */
    private Control BuildSendButtons()
    {
        FlowLayoutPanel group = NewPage();
        group.Margin = M(14, 0);

        mySendRow = NewRow(M(0, 0));
        mySendButton = new SpidxButton { Text = "Upload", Kind = SpidxBtnKind.Primary };
        mySendButton.Click += (s, e) => PerformUpload(false);
        myPsUploadButton = new SpidxButton { Text = "Photoshop + Upload", Kind = SpidxBtnKind.Secondary, Enabled = false };
        myPsUploadButton.Click += (s, e) => PerformUpload(true);
        mySendRow.Controls.Add(mySendButton);
        mySendRow.Controls.Add(myPsUploadButton);

        myRouteLineLabel = new SpidxLabel { Text = "", AutoFit = true, HideWhenEmpty = true, Margin = M(6, 0) };
        myRouteLineLabel.SetFont(10.5f, 400);

        group.Controls.Add(mySendRow);
        group.Controls.Add(myRouteLineLabel);
        return group;
    }

    /* -- .file-row: last exported file (thumb 30px / name 11px/600 / size 10px), margin-top 12 -- */
    private Control BuildFileRow()
    {
        myFileRow = new SpidxCard(CardKind.Plain) { Radius = 10, Visible = false, Margin = M(12, 0) };
        myFileThumb = new SpidxBadge { Radius = 7, FontPx = 8.5f, Weight = 700, BackColor = Sx.Surface };
        myFileThumb.Configure("PNG", Sx.SurfaceAlt, Sx.Dim);
        myFileName = new SpidxLabel { Text = "\u2014", ForeColor = Sx.Text, Wrap = false, Ellipsis = true };
        myFileName.SetFont(11f, 600);
        myFileSize = new SpidxLabel { Text = "\u2014", ForeColor = Sx.Faint, Wrap = false };
        myFileSize.SetFont(10f, 400);
        myFileRow.Controls.Add(myFileThumb);
        myFileRow.Controls.Add(myFileName);
        myFileRow.Controls.Add(myFileSize);
        return myFileRow;
    }

    /* -- .batch-progress: dots + text + Send now / Cancel, margin-top 12 -- */
    private Control BuildBatchProgressPanel()
    {
        myBatchProgressPanel = NewRow(M(12, 0));
        myBatchProgressPanel.Visible = false;
        myBatchDots = new SpidxBatchDots();
        myBatchProgressText = new SpidxLabel { Text = "", Center = true, Wrap = false };
        myBatchProgressText.SetFont(10.5f, 400);
        mySendNowButton = new SpidxButton { Text = "Send now", Kind = SpidxBtnKind.Small };
        mySendNowButton.Click += (s, e) => HandleSendNow();
        myCancelButton = new SpidxButton { Text = "Cancel", Kind = SpidxBtnKind.SmallDanger };
        myCancelButton.Click += (s, e) => HandleCancelBatch();
        myBatchProgressPanel.Controls.Add(myBatchDots);
        myBatchProgressPanel.Controls.Add(myBatchProgressText);
        myBatchProgressPanel.Controls.Add(mySendNowButton);
        myBatchProgressPanel.Controls.Add(myCancelButton);
        return myBatchProgressPanel;
    }

    /* -- .foot: link (left) + path (right, truncated from the start), 10px, margin-top 13 -- */
    private Control BuildFooter()
    {
        myFooterRow = NewRow(M(13, 0));
        myChangeFolderLink = new SpidxLabel { Text = "Change incoming folder", ForeColor = Sx.AccentAlt, Wrap = false, IsLink = true };
        myChangeFolderLink.SetFont(10f, 400);
        myChangeFolderLink.Click += (s, e) => HandleChangeFolder();
        myFolderPathLabel = new SpidxLabel { Text = "", ForeColor = Sx.Faint, Wrap = false, AlignRight = true, StartEllipsis = true };
        myFolderPathLabel.SetFont(10f, 400);
        myFooterRow.Controls.Add(myChangeFolderLink);
        myFooterRow.Controls.Add(myFolderPathLabel);
        return myFooterRow;
    }

    private void LayoutFooter()
    {
        if (myFooterRow == null) return;
        int h = myChangeFolderLink.LineHeight();
        myFooterRow.Size = new Size(myW, h);
        int linkW = myChangeFolderLink.PreferredWidth();
        myChangeFolderLink.SetBounds(0, 0, linkW, h);
        int pathX = linkW + S(8);
        myFolderPathLabel.SetBounds(pathX, 0, Math.Max(10, myW - pathX), h);
    }

    private string LbCacheFile()
    {
        return string.IsNullOrEmpty(myIncomingFolder) ? null : Path.Combine(myIncomingFolder, LbCacheName);
    }

    private void LbSaveCache(List<Dictionary<string, object>> players)
    {
        string file = LbCacheFile();
        if (file == null) return;
        var payload = new Dictionary<string, object> { { "savedAt", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }, { "players", players } };
        WriteJson(file, payload);
    }

    private void LbUseCache(string reasonWhyLive)
    {
        string file = LbCacheFile();
        Dictionary<string, object> cache = file != null ? ReadJson(file) : null;
        List<object> rawPlayers = cache != null ? GetList(cache, "players") : null;

        if (rawPlayers == null || rawPlayers.Count == 0)
        {
            myLbPlayers = new List<Dictionary<string, object>>();
            LbRenderRows();
            myLbStatus.Text = reasonWhyLive;
            myLbStatus.ForeColor = Sx.Err;
            return;
        }

        myLbPlayers = rawPlayers.Select(p => p as Dictionary<string, object>).Where(p => p != null).ToList();
        LbRenderRows();
        long savedAt = GetLong(cache, "savedAt");
        myLbStatus.Text = "Offline \u2014 cached data from " + LbCacheAgeText(savedAt) + " (" + myLbPlayers.Count + " players) \u00b7 " + reasonWhyLive;
        myLbStatus.ForeColor = Sx.Err;
    }

    private static string LbCacheAgeText(long savedAt)
    {
        long mins = (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - savedAt) / 60000;
        if (mins < 1) return "just now";
        if (mins == 1) return "1 min ago";
        if (mins < 60) return mins + " min ago";
        long hours = mins / 60;
        return hours == 1 ? "1 hour ago" : hours + " hours ago";
    }

    private void LbRenderRows()
    {
        myLbSelectedIndex = -1;
        myLbCopyBtn.Enabled = false;
        myLbMessage.Text = "";

        List<string[]> rows = new List<string[]>();
        for (int i = 0; i < myLbPlayers.Count; i++)
        {
            Dictionary<string, object> p = myLbPlayers[i];
            long rank = GetLong(p, "rank");
            string nick = GetString(p, "alias") ?? GetString(p, "name") ?? "?";
            long points = GetLong(p, "points");
            rows.Add(new string[] { (rank > 0 ? rank : i + 1).ToString(), nick, points.ToString("N0") });
        }
        myLbList.SetRows(rows);
        RefreshAll();
    }

    private void LbLoad()
    {
        try { LbLoadCore(); }
        catch (Exception ex)
        {
            if (myLbStatus != null) { myLbStatus.Text = "Leaderboard error: " + ex.Message; myLbStatus.ForeColor = Sx.Err; }
        }
    }

    private void LbLoadCore()
    {
        myLbLoadedOnce = true;
        myLbCopyBtn.Enabled = false;
        myLbMessage.Text = "";
        myLbStatus.Text = "Loading...";
        myLbStatus.ForeColor = Sx.Dim;

        if (myLbWebClient != null)
        {
            try { myLbWebClient.CancelAsync(); } catch { }
        }
        myLbWebClient = new WebClient();
        // Without this, WebClient falls back to the system's ANSI code page
        // (e.g. Windows-1252) for any response that doesn't explicitly say
        // "charset=utf-8" in its Content-Type header — which this API's
        // plain "application/json" doesn't. Every non-ASCII character in a
        // nickname then gets mis-decoded (mojibake like "95Ç", "bÄ¤...").
        myLbWebClient.Encoding = System.Text.Encoding.UTF8;
        myLbWebClient.Headers["User-Agent"] = "SpidxUploaderVegas";
        myLbWebClient.DownloadStringCompleted += LbDownloadCompleted;

        string region = myLbRegion.SelectedItem ?? "All";
        string search = myLbSearch.Text.Trim();
        List<string> parts = new List<string>();
        if (region != "All") parts.Add("region=" + Uri.EscapeDataString(region));
        if (!string.IsNullOrEmpty(search)) parts.Add("search=" + Uri.EscapeDataString(search));
        parts.Add("sort=points&order=desc");
        string query = parts.Count > 0 ? ("?" + string.Join("&", parts)) : "";

        try
        {
            myLbWebClient.DownloadStringAsync(new Uri(LbApiHost + "/api/fortnite" + query));
        }
        catch (Exception ex)
        {
            LbUseCache(ex.Message);
        }
    }

    private void LbDownloadCompleted(object sender, DownloadStringCompletedEventArgs e)
    {
        if (myLbStatus == null || myLbStatus.IsDisposed) return;
        if (!ReferenceEquals(sender, myLbWebClient)) return;   // stale request (region/search changed meanwhile)
        if (myLbStatus.InvokeRequired)
        {
            try { myLbStatus.BeginInvoke(new Action(() => LbDownloadCompleted(sender, e))); } catch { }
            return;
        }
        try { LbDownloadCompletedCore(e); }
        catch (Exception ex)
        {
            myLbStatus.Text = "Leaderboard error: " + ex.Message;
            myLbStatus.ForeColor = Sx.Err;
        }
    }

    private void LbDownloadCompletedCore(DownloadStringCompletedEventArgs e)
    {
        if (e.Cancelled) return;

        if (e.Error != null)
        {
            LbUseCache(e.Error.Message);
            return;
        }

        Dictionary<string, object> json;
        try
        {
            json = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(e.Result);
        }
        catch
        {
            LbUseCache("API responded, but without the expected data.");
            return;
        }

        if (json == null || !GetBool(json, "success"))
        {
            LbUseCache("API responded, but without the expected data.");
            return;
        }

        List<object> rawPlayers = GetList(json, "data") ?? new List<object>();
        myLbPlayers = rawPlayers.Select(p => p as Dictionary<string, object>).Where(p => p != null).ToList();

        if (myLbPlayers.Count == 0)
        {
            LbRenderRows();
            myLbStatus.Text = "No results for the current filters.";
            myLbStatus.ForeColor = Sx.Err;
            return;
        }

        LbRenderRows();
        LbSaveCache(myLbPlayers);
        myLbStatus.Text = "Connected \u00b7 " + myLbPlayers.Count + " players";
        myLbStatus.ForeColor = Sx.Ok;
    }

    private void LbCopyNick()
    {
        if (myLbSelectedIndex < 0 || myLbSelectedIndex >= myLbPlayers.Count) return;
        Dictionary<string, object> player = myLbPlayers[myLbSelectedIndex];
        string nick = GetString(player, "alias") ?? GetString(player, "name") ?? "";
        try
        {
            Clipboard.SetText(nick);
            myLbMessage.Text = "Copied: " + nick;
            myLbMessage.ForeColor = Sx.Ok;
        }
        catch (Exception ex)
        {
            myLbMessage.Text = "Could not copy to clipboard: " + ex.Message;
            myLbMessage.ForeColor = Sx.Err;
        }
    }

    /* ------------------------------------------------------------------ *
     *  Batch selector logic — mirrors client/index.js exactly.
     * ------------------------------------------------------------------ */
    private bool TierAllowsMultiBatch()
    {
        return myCurrentTier != null && MultiBatchTiers.Contains(myCurrentTier);
    }

    private void UpdateFolderNameVisibility()
    {
        bool show = myCurrentDestination == "drive" && mySelectedBatchCount > 1;
        myFolderNameRow.Visible = show;
    }

    private void SetBatchControlsLocked(bool locked)
    {
        bool allowMulti = TierAllowsMultiBatch();
        for (int i = 0; i < myBatchButtons.Length; i++)
        {
            int count = i + 1;
            bool tierBlocked = count > 1 && !allowMulti;
            myBatchButtons[i].Enabled = !locked && !tierBlocked;
        }
        if (myFolderNameInput != null) myFolderNameInput.Enabled = !locked;
    }

    private void SetSelectedBatchCount(int count, bool persist)
    {
        mySelectedBatchCount = count;
        for (int i = 0; i < myBatchButtons.Length; i++)
        {
            myBatchButtons[i].IsActive = (i + 1) == count;
            myBatchButtons[i].Invalidate();
        }
        UpdateFolderNameVisibility();
        if (persist)
        {
            SavePanelConfig();
            WriteBatchConfig();
        }
    }

    private void WriteBatchConfig()
    {
        if (string.IsNullOrEmpty(myIncomingFolder)) return;
        var payload = new Dictionary<string, object>
        {
            { "targetCount", mySelectedBatchCount },
            { "folderName", myFolderNameValue ?? "" }
        };
        WriteJson(Path.Combine(myIncomingFolder, BatchConfigName), payload);
    }

    private void HandleSendNow()
    {
        if (string.IsNullOrEmpty(myIncomingFolder)) return;
        File.WriteAllText(Path.Combine(myIncomingFolder, BatchForceSendName), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString());
        SetCard("Sending now", "Pushing through whatever has been collected.", CardState.Normal);
    }

    private void HandleCancelBatch()
    {
        if (string.IsNullOrEmpty(myIncomingFolder)) return;
        File.WriteAllText(Path.Combine(myIncomingFolder, BatchCancelName), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString());
        SetCard("Batch cancelled", "Nothing was uploaded.", CardState.Normal);
        myProgressBar.SetPercent(0, false);
    }

    private void HandleChangeFolder()
    {
        using (FolderBrowserDialog dialog = new FolderBrowserDialog())
        {
            dialog.Description = "Choose the Spidx Uploader App\\incoming folder";
            if (dialog.ShowDialog() != DialogResult.OK) return;
            myIncomingFolder = dialog.SelectedPath;
            SavePanelConfig();
            UpdateFolderLabel();
            SetCard("Folder updated", "Ready to export", CardState.Ok);
        }
    }

    private void UpdateFolderLabel()
    {
        if (myFolderPathLabel == null) return;
        myFolderPathLabel.Text = string.IsNullOrEmpty(myIncomingFolder) ? "no folder linked" : myIncomingFolder;
        myFolderPathLabel.Invalidate();
    }

    private string EnsureIncomingFolder()
    {
        if (!string.IsNullOrEmpty(myIncomingFolder) && Directory.Exists(myIncomingFolder)) return myIncomingFolder;

        SetCard("Select folder", "Choose the App\\incoming folder...", CardState.Normal);
        using (FolderBrowserDialog dialog = new FolderBrowserDialog())
        {
            dialog.Description = "Choose the Spidx Uploader App\\incoming folder";
            if (dialog.ShowDialog() != DialogResult.OK) throw new Exception("No incoming folder was selected.");
            myIncomingFolder = dialog.SelectedPath;
            SavePanelConfig();
            UpdateFolderLabel();
            return myIncomingFolder;
        }
    }

    /* ------------------------------------------------------------------ *
     *  Upload — mirrors performUpload()/finishUpload() in client/index.js.
     * ------------------------------------------------------------------ */
    private void PerformUpload(bool viaPhotoshop)
    {
        if (myBusy) return;

        SpidxButton activeButton = viaPhotoshop ? myPsUploadButton : mySendButton;
        SpidxButton otherButton = viaPhotoshop ? mySendButton : myPsUploadButton;
        string defaultLabel = viaPhotoshop ? "Photoshop + Upload" : "Upload";

        myBusy = true;
        activeButton.Enabled = false;
        if (otherButton != null) otherButton.Enabled = false;
        activeButton.Text = "Saving...";
        HideFileRow();
        myProgressBar.SetPercent(10, false);

        try
        {
            string folder = EnsureIncomingFolder();
            WriteBatchConfig();

            if (myEngineOnline == false)
            {
                SetCard("Helper not running", "Saving the frame anyway — it uploads when the helper starts.", CardState.Error);
            }

            SetCard("Saving frame...", "Exporting the current frame as PNG.", CardState.Normal);
            myProgressBar.SetPercent(45, false);

            string savedName;
            long savedBytes;
            SaveCurrentFrame(myVegas, folder, viaPhotoshop, out savedName, out savedBytes);

            myProgressBar.SetPercent(100, true);
            ShowFileRow(savedName, savedBytes);

            if (mySelectedBatchCount > 1)
            {
                SetCard("Added to batch", "Waiting for the rest (" + mySelectedBatchCount + " total) — export the next one the same way.", CardState.Ok);
            }
            else
            {
                SetCard("File ready", "The helper will compress and send it automatically.", CardState.Ok);
            }

            activeButton.Text = "Done";
        }
        catch (Exception ex)
        {
            SetCard("Error", ex.Message, CardState.Error);
            myProgressBar.SetPercent(0, false);
            activeButton.Text = "Try again";
            ShowDiagnostic("PerformUpload (saving/sending the frame)", ex);
        }
        finally
        {
            myBusy = false;
            activeButton.Enabled = true;
            if (otherButton != null) otherButton.Enabled = true;
            UpdateRouteLine();

            Timer resetTimer = new Timer { Interval = 2500 };
            resetTimer.Tick += (s, e) =>
            {
                activeButton.Text = defaultLabel;
                resetTimer.Stop();
                resetTimer.Dispose();
            };
            resetTimer.Start();
        }
    }

    private void SaveCurrentFrame(Vegas vegas, string incomingFolder, bool viaPhotoshop, out string finalName, out long bytes)
    {
        string stamp = "spidx_" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        finalName = viaPhotoshop ? (stamp + ".ps.png") : (stamp + ".png");
        string partPath = Path.Combine(incomingFolder, stamp + ".pngpart");
        string finalPath = Path.Combine(incomingFolder, finalName);

        RenderStatus status = vegas.SaveSnapshot(partPath, ImageFileFormat.PNG, vegas.Transport.CursorPosition);
        if (status != RenderStatus.Complete)
        {
            throw new Exception("VEGAS did not complete the snapshot (status: " + status
                + "). Is a project open with something on the timeline at the cursor?");
        }

        File.Move(partPath, finalPath);
        bytes = new FileInfo(finalPath).Length;
    }

    private void ShowFileRow(string name, long bytes)
    {
        myFileThumb.Configure("PNG", Sx.SurfaceAlt, Sx.Dim);
        myFileName.Text = name;
        myFileSize.Text = FormatBytes(bytes);
        myFileRow.Visible = true;
    }

    private void HideFileRow()
    {
        myFileRow.Visible = false;
    }

    private static string FormatBytes(long bytes)
    {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024.0).ToString("0.0") + " KB";
        return (bytes / (1024.0 * 1024.0)).ToString("0.00") + " MB";
    }

    /* ------------------------------------------------------------------ *
     *  Status polling — mirrors poll()/applyEngineStatus()/
     *  applyBatchStatus()/updateRouteLine() in client/index.js.
     * ------------------------------------------------------------------ */
    private void StartPolling()
    {
        myPollTimer = new Timer { Interval = PollIntervalMs };
        myPollTimer.Tick += (s, e) => Poll();
        myPollTimer.Start();
        Poll();
    }

    private void StopPolling()
    {
        if (myPollTimer != null)
        {
            myPollTimer.Stop();
            myPollTimer.Dispose();
            myPollTimer = null;
        }
        if (myLbSearchTimer != null)
        {
            myLbSearchTimer.Stop();
            myLbSearchTimer.Dispose();
            myLbSearchTimer = null;
        }
        if (myLbWebClient != null)
        {
            try { myLbWebClient.CancelAsync(); } catch { }
            myLbWebClient = null;
        }
    }

    private void Poll()
    {
        if (string.IsNullOrEmpty(myIncomingFolder)) return;
        ApplyEngineStatus(ReadJson(Path.Combine(myIncomingFolder, EngineStatusName)));
        ApplyBatchStatus(ReadJson(Path.Combine(myIncomingFolder, BatchStatusName)));
        UpdateRouteLine();
    }

    private void ApplyEngineStatus(Dictionary<string, object> status)
    {
        long stamp = status != null ? GetLong(status, "updatedAt") : 0;
        bool online = stamp > 0 && (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - stamp) < EngineStaleMs;

        if (myEngineOnline == null || online != myEngineOnline.Value)
        {
            myEngineOnline = online;
            if (!online)
            {
                SetCard("Helper not running",
                    "Start \"Spidx Uploader.vbs\" — nothing is watching the incoming folder right now.",
                    CardState.Error);
                myProgressBar.SetPercent(0, false);
            }
            else if (!myBusy)
            {
                SetCard("Ready", "Helper is running — send away.", CardState.Normal);
            }
        }

        if (status == null) return;

        string destination = GetString(status, "destination");
        if (!string.IsNullOrEmpty(destination)) myCurrentDestination = destination;
        myCurrentDeviceLimitReached = GetBool(status, "deviceLimitReached");

        string tier = GetString(status, "tier");
        if (tier != myCurrentTier)
        {
            myCurrentTier = tier;
            if (!TierAllowsMultiBatch() && mySelectedBatchCount > 1) SetSelectedBatchCount(1, true);
            SetBatchControlsLocked(false);
        }

        if (!string.IsNullOrEmpty(tier))
        {
            long trialDays = GetLong(status, "trialDaysRemaining");
            myTierBadge.SetTier(tier, trialDays);
            myTierBadge.Visible = true;
        }
        else
        {
            myTierBadge.Visible = false;
        }
        LayoutHeader();

        myWarnBox.Visible = myCurrentDeviceLimitReached;
        UpdateFolderNameVisibility();
    }

    private void ApplyBatchStatus(Dictionary<string, object> status)
    {
        string state = status != null ? (GetString(status, "state") ?? "idle") : "idle";

        if (state == "collecting")
        {
            long have = status != null ? GetLong(status, "have") : 0;
            long target = status != null ? GetLong(status, "target") : mySelectedBatchCount;
            myBatchDots.SetProgress((int)have, (int)Math.Max(target, 1));
            myBatchProgressText.Text = have + " of " + target + " received";
            myBatchProgressPanel.Visible = true;
            SetBatchControlsLocked(true);
        }
        else
        {
            myBatchProgressPanel.Visible = false;
            if (!myBusy) SetBatchControlsLocked(false);
        }

        if (state == "uploading" && myLastBatchState != "uploading")
        {
            SetCard("Uploading...", "Spider Engine is sending the file(s) now.", CardState.Normal);
            myProgressBar.SetIndeterminate(true);
        }

        if (state == "done" && myLastBatchState != "done")
        {
            myProgressBar.SetPercent(100, true);
            List<object> links = status != null ? GetList(status, "links") : null;
            bool hasLinks = links != null && links.Count > 0;
            SetCard("Uploaded", hasLinks ? "Link copied to the clipboard." : "Sent — no link was detected.", CardState.Ok);
            SetSelectedBatchCount(1, true);
        }

        if (myLastBatchState == "uploading" && state != "uploading" && state != "done") myProgressBar.SetPercent(0, false);
        myLastBatchState = state;
    }

    private void UpdateRouteLine()
    {
        if (string.IsNullOrEmpty(myIncomingFolder)) return;
        Dictionary<string, object> preset = ReadJson(Path.Combine(myIncomingFolder, CameraRawPresetName));
        string actionName = preset != null ? GetString(preset, "actionName") : null;
        bool hasPreset = !string.IsNullOrEmpty(actionName);

        myPsUploadButton.Enabled = !myBusy && hasPreset;
        myRouteLineLabel.Text = hasPreset
            ? "Photoshop + Upload runs \u201c" + actionName + "\u201d \u2014 requires Photoshop already open."
            : "Set a Camera Raw Action in the Dashboard to enable Photoshop + Upload.";
    }

    /* ------------------------------------------------------------------ *
     *  Status card helper
     * ------------------------------------------------------------------ */
    private void SetCard(string title, string sub, CardState state)
    {
        if (myCardTitle == null) return;
        bool changed = myCardTitle.Text != title;
        myCardTitle.Text = title;
        myCardSub.Text = sub ?? "";
        myCardSub.ForeColor = state == CardState.Ok ? Sx.Ok : state == CardState.Error ? Sx.Err : Sx.Dim;
        myStatusCard.SetState(state);
        FitStatusCard();
        if (changed) myStatusCard.Pulse();
    }

    /* ------------------------------------------------------------------ *
     *  This extension's own settings — separate from the protocol files
     *  above (those are Spider Engine's, shared with the other panels).
     * ------------------------------------------------------------------ */
    private string ConfigPath()
    {
        string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Spidx Uploader");
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, OwnConfigFileName);
    }

    private void LoadPanelConfig()
    {
        Dictionary<string, object> cfg = ReadJson(ConfigPath());
        if (cfg == null) return;
        myIncomingFolder = GetString(cfg, "incomingFolder");
        long savedCount = GetLong(cfg, "batchCount");
        mySelectedBatchCount = (savedCount == 2 || savedCount == 3) ? (int)savedCount : 1;
        myFolderNameValue = GetString(cfg, "folderName") ?? "";
        object scaleObj;
        double scale;
        if (cfg.TryGetValue("uiScale", out scaleObj) && scaleObj != null
            && double.TryParse(Convert.ToString(scaleObj, System.Globalization.CultureInfo.InvariantCulture), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out scale))
            Sx.SetScale((float)scale);
    }

    private void SavePanelConfig()
    {
        var payload = new Dictionary<string, object>
        {
            { "incomingFolder", myIncomingFolder ?? "" },
            { "batchCount", mySelectedBatchCount },
            { "folderName", myFolderNameValue ?? "" },
            { "uiScale", (double)Sx.K }
        };
        WriteJson(ConfigPath(), payload);
    }

    /* ------------------------------------------------------------------ *
     *  JSON helpers
     * ------------------------------------------------------------------ */
    private static Dictionary<string, object> ReadJson(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            string text = File.ReadAllText(path);
            if (string.IsNullOrWhiteSpace(text)) return null;
            return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text);
        }
        catch
        {
            return null;
        }
    }

    private static void WriteJson(string path, Dictionary<string, object> data)
    {
        try
        {
            File.WriteAllText(path, new JavaScriptSerializer().Serialize(data));
        }
        catch
        {
            // Not fatal — worst case a setting doesn't persist this session.
        }
    }

    private static string GetString(Dictionary<string, object> dict, string key)
    {
        object value;
        if (!dict.TryGetValue(key, out value) || value == null) return null;
        return value.ToString();
    }

    private static bool GetBool(Dictionary<string, object> dict, string key)
    {
        object value;
        if (!dict.TryGetValue(key, out value) || value == null) return false;
        if (value is bool) return (bool)value;
        bool parsed;
        return bool.TryParse(value.ToString(), out parsed) && parsed;
    }

    private static long GetLong(Dictionary<string, object> dict, string key)
    {
        object value;
        if (!dict.TryGetValue(key, out value) || value == null) return 0;
        try { return Convert.ToInt64(value); } catch { return 0; }
    }

    private static List<object> GetList(Dictionary<string, object> dict, string key)
    {
        object value;
        if (!dict.TryGetValue(key, out value) || value == null) return null;
        // JavaScriptSerializer.Deserialize<Dictionary<string,object>> turns
        // every JSON array into an ArrayList, never List<object> or
        // object[] — the two casts this used to try both silently missed,
        // so this always fell through to an empty list regardless of what
        // the API actually returned. That's the whole "Leaderboard shows
        // nothing" bug.
        if (value is ArrayList) return ((ArrayList)value).Cast<object>().ToList();
        if (value is List<object>) return (List<object>)value;
        if (value is object[]) return ((object[])value).ToList();
        return null;
    }
}

public enum CardState { Normal, Ok, Error }
public enum CardKind { Status, Warn, Plain }
public enum SpidxBtnKind { Primary, Secondary, Small, SmallDanger, Tab, Toolbar }

/* ========================================================================
 *  Sx — every color constant, taken 1:1 from the AE panel's :root CSS
 *  custom properties (panel-ae.html), plus font helpers. Fonts are
 *  specified in PIXELS (GraphicsUnit.Pixel) exactly like the CSS
 *  font-size values, so 11.5px here is the same 11.5px as in the panel.
 * ==================================================================== */
public static class Sx
{
    public static readonly Color Bg = Color.FromArgb(28, 28, 30);           // --bg: #1c1c1e
    public static readonly Color Surface = Color.FromArgb(44, 44, 46);      // --surface: #2c2c2e
    public static readonly Color SurfaceAlt = Color.FromArgb(58, 58, 60);   // --surface-2: #3a3a3c
    public static readonly Color Line = Color.FromArgb(26, 255, 255, 255);  // --line: rgba(255,255,255,.10)
    public static readonly Color Text = Color.FromArgb(245, 245, 247);      // --text: #f5f5f7
    public static readonly Color Dim = Color.FromArgb(152, 152, 157);       // --dim: #98989d
    public static readonly Color Faint = Color.FromArgb(99, 99, 102);       // --faint: #636366
    public static readonly Color Accent = Color.FromArgb(10, 132, 255);     // --accent: #0a84ff
    public static readonly Color AccentAlt = Color.FromArgb(100, 210, 255); // --accent-2: #64d2ff
    public static readonly Color Ok = Color.FromArgb(48, 209, 88);          // --ok: #30d158
    public static readonly Color Err = Color.FromArgb(255, 69, 58);         // --err: #ff453a

    // .warn-box
    public static readonly Color WarnBg = Color.FromArgb(26, 255, 176, 32);      // rgba(255,176,32,.10)
    public static readonly Color WarnBorder = Color.FromArgb(77, 255, 176, 32);  // rgba(255,176,32,.30)
    public static readonly Color WarnText = Color.FromArgb(255, 206, 106);       // #ffce6a

    // .seg button.active — rgba(10,132,255,.22)
    public static readonly Color SegActiveBg = Color.FromArgb(56, 10, 132, 255);
    // .lb-item.selected — rgba(10,132,255,.18)
    public static readonly Color RowSelected = Color.FromArgb(46, 10, 132, 255);

    // .tier-badge.tier-*
    public static readonly Color TierDefaultBg = SurfaceAlt;
    public static readonly Color TierDefaultText = Color.FromArgb(174, 174, 178);
    public static readonly Color TierProBg = Color.FromArgb(74, 58, 18);
    public static readonly Color TierProText = Color.FromArgb(255, 214, 10);
    public static readonly Color TierDevBg = Color.FromArgb(58, 36, 80);
    public static readonly Color TierDevText = Color.FromArgb(191, 90, 242);
    public static readonly Color TierTesterBg = Color.FromArgb(18, 58, 74);
    public static readonly Color TierTesterText = AccentAlt;

    /// <summary>UI scale: the AE panel's CSS px sizes x K (VEGAS's own UI is larger than the Adobe sidebar).</summary>
    public static float K = 1.3f;
    public static int S(int v) { return (int)Math.Round(v * K); }
    public static void SetScale(float k)
    {
        K = Math.Max(0.8f, Math.Min(2.5f, k));
        FontCache.Clear();
    }

    private static readonly Dictionary<string, Font> FontCache = new Dictionary<string, Font>();

    /// <summary>CSS-like font: size in px, weight 400 / 600 (Semibold) / 700 (Bold).</summary>
    public static Font Fnt(float px, int weight)
    {
        return Fnt(px, weight, false);
    }

    public static Font Fnt(float px, int weight, bool underline)
    {
        string key = px.ToString(System.Globalization.CultureInfo.InvariantCulture) + "/" + weight + "/" + (underline ? "u" : "");
        Font f;
        if (!FontCache.TryGetValue(key, out f))
        {
            System.Drawing.FontStyle style = weight >= 700 ? System.Drawing.FontStyle.Bold : System.Drawing.FontStyle.Regular;
            if (underline) style |= System.Drawing.FontStyle.Underline;
            string family = weight == 600 ? "Segoe UI Semibold" : "Segoe UI";
            f = new Font(family, px * K, style, GraphicsUnit.Pixel);
            FontCache[key] = f;
        }
        return f;
    }

    public static Color Lerp(Color a, Color b, double t)
    {
        t = Math.Max(0, Math.Min(1, t));
        return Color.FromArgb(
            (int)Math.Round(a.A + (b.A - a.A) * t),
            (int)Math.Round(a.R + (b.R - a.R) * t),
            (int)Math.Round(a.G + (b.G - a.G) * t),
            (int)Math.Round(a.B + (b.B - a.B) * t));
    }

    /// <summary>filter: brightness(x) — multiplies each channel.</summary>
    public static Color Brighten(Color c, double factor)
    {
        return Color.FromArgb(c.A,
            Math.Min(255, (int)(c.R * factor)),
            Math.Min(255, (int)(c.G * factor)),
            Math.Min(255, (int)(c.B * factor)));
    }

    /// <summary>opacity: x on an opaque colour sitting over `over`.</summary>
    public static Color Blend(Color c, Color over, double opacity)
    {
        return Color.FromArgb(255,
            (int)(c.R * opacity + over.R * (1 - opacity)),
            (int)(c.G * opacity + over.G * (1 - opacity)),
            (int)(c.B * opacity + over.B * (1 - opacity)));
    }

    /// <summary>opacity: x on a (possibly translucent) fill/border — keeps it translucent.</summary>
    public static Color Fade(Color c, double opacity)
    {
        return Color.FromArgb((int)(c.A * opacity), c.R, c.G, c.B);
    }

    public static GraphicsPath RoundedRect(Rectangle bounds, int radius)   // radius already in real px
    {
        int d = radius * 2;
        if (d <= 0 || bounds.Width <= d || bounds.Height <= d)
        {
            GraphicsPath simple = new GraphicsPath();
            simple.AddRectangle(bounds);
            return simple;
        }
        GraphicsPath path = new GraphicsPath();
        path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}

/* ========================================================================
 *  Custom-drawn controls — plain WinForms OnPaint/GraphicsPath/SolidBrush,
 *  styled from Sx's CSS-sourced colors and pixel-based fonts.
 * ==================================================================== */

/// <summary>
/// One shared 15ms UI-thread timer that drives every animation in the panel.
/// It only runs while something is animating, and every step is exception-safe
/// (an exception in an animation must never take VEGAS down).
/// </summary>
public static class SpidxAnim
{
    private static readonly List<Func<double, bool>> Steps = new List<Func<double, bool>>();
    private static Timer myTimer;
    private static long myLast;

    /// <summary>Registers a step(dtMs) -> keepRunning callback (same delegate instance = registered once).</summary>
    public static void Run(Func<double, bool> step)
    {
        if (!Steps.Contains(step)) Steps.Add(step);
        if (myTimer == null)
        {
            myTimer = new Timer { Interval = 15 };
            myTimer.Tick += Tick;
        }
        if (!myTimer.Enabled)
        {
            myLast = System.Diagnostics.Stopwatch.GetTimestamp();
            myTimer.Start();
        }
    }

    private static void Tick(object sender, EventArgs e)
    {
        long now = System.Diagnostics.Stopwatch.GetTimestamp();
        double dt = (now - myLast) * 1000.0 / System.Diagnostics.Stopwatch.Frequency;
        myLast = now;
        if (dt > 100) dt = 100;
        for (int i = Steps.Count - 1; i >= 0; i--)
        {
            bool keep;
            try { keep = Steps[i](dt); } catch { keep = false; }
            if (!keep) Steps.RemoveAt(i);
        }
        if (Steps.Count == 0) myTimer.Stop();
    }

    public static double Approach(double value, double target, double delta)
    {
        if (value < target) return Math.Min(target, value + delta);
        return Math.Max(target, value - delta);
    }
}

/// <summary>
/// Text label drawn with TextRenderer: pixel fonts, optional letter-spacing
/// (.label's letter-spacing: .08em), centre/right alignment, word-wrap,
/// end-ellipsis, start-ellipsis (the path in .foot uses direction: rtl),
/// link hover underline, and auto-height for wrapped text.
/// </summary>
public class SpidxLabel : Control
{
    public float Tracking;          // letter-spacing in px
    public bool Center;
    public bool AlignRight;
    public bool Wrap = true;
    public bool Ellipsis;           // single-line "..." at the end
    public bool StartEllipsis;      // single-line "..." at the start (paths)
    public bool AutoFit;            // Height follows wrapped text height
    public bool HideWhenEmpty;      // (with AutoFit) Visible = text not empty
    public bool IsLink;             // hover underline + hand cursor
    public float FontPx = 10.5f;
    public int Weight = 400;

    private bool myHover;
    private bool myRefitting;

    public SpidxLabel()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer
                 | ControlStyles.SupportsTransparentBackColor | ControlStyles.ResizeRedraw, true);
        BackColor = Color.Transparent;
        ForeColor = Sx.Dim;
        TabStop = false;
        Font = Sx.Fnt(FontPx, Weight);
    }

    public void SetFont(float px, int weight)
    {
        FontPx = px;
        Weight = weight;
        Font = Sx.Fnt(px, weight);
        Refit();
        Invalidate();
    }

    private TextFormatFlags Flags()
    {
        TextFormatFlags f = TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.Top;
        f |= Wrap ? TextFormatFlags.WordBreak : TextFormatFlags.SingleLine;
        if (Center) f |= TextFormatFlags.HorizontalCenter;
        else if (AlignRight) f |= TextFormatFlags.Right;
        if (Ellipsis && !Wrap) f |= TextFormatFlags.EndEllipsis;
        return f;
    }

    private int MeasureW(string s, Font font)
    {
        return TextRenderer.MeasureText(s, font, new Size(100000, 1000),
            TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine).Width;
    }

    public int LineHeight()
    {
        return TextRenderer.MeasureText("Ag", Font, new Size(100000, 1000),
            TextFormatFlags.NoPadding | TextFormatFlags.SingleLine).Height;
    }

    public int PreferredWidth()
    {
        if (string.IsNullOrEmpty(Text)) return 0;
        int w = MeasureW(Text, Font);
        if (Tracking > 0.01f) w += (int)Math.Ceiling(Tracking * Text.Length);
        return w + 1;
    }

    public int HeightFor(int width)
    {
        if (string.IsNullOrEmpty(Text)) return 0;
        int lh = LineHeight();
        if (!Wrap || Tracking > 0.01f || width <= 0) return lh;
        Size s = TextRenderer.MeasureText(Text, Font, new Size(width, 100000), Flags());
        return Math.Max(lh, s.Height);
    }

    public void Refit()
    {
        if (!AutoFit || myRefitting) return;
        myRefitting = true;
        try
        {
            int h = HeightFor(Width);
            if (HideWhenEmpty) Visible = h > 0;
            if (h > 0 && h != Height) Height = h;
        }
        finally { myRefitting = false; }
    }

    protected override void OnTextChanged(EventArgs e)
    {
        base.OnTextChanged(e);
        Refit();
        Invalidate();
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        Refit();
    }

    protected override void OnForeColorChanged(EventArgs e) { base.OnForeColorChanged(e); Invalidate(); }
    protected override void OnMouseEnter(EventArgs e)
    {
        base.OnMouseEnter(e);
        if (IsLink) { myHover = true; Cursor = Cursors.Hand; Invalidate(); }
    }
    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (IsLink) { myHover = false; Invalidate(); }
    }

    private string FitStart(string s, int width)
    {
        if (MeasureW(s, Font) <= width) return s;
        for (int i = 1; i < s.Length; i++)
        {
            string t = "\u2026" + s.Substring(i);
            if (MeasureW(t, Font) <= width) return t;
        }
        return "\u2026";
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        if (string.IsNullOrEmpty(Text)) return;
        Rectangle r = ClientRectangle;
        Color fc = Enabled ? ForeColor : Sx.Faint;
        Font font = (IsLink && myHover) ? Sx.Fnt(FontPx, Weight, true) : Font;

        if (Tracking > 0.01f)
        {
            float x = r.X;
            using (StringFormat fmt = StringFormat.GenericTypographic)
            {
                foreach (char ch in Text)
                {
                    if (ch == ' ') { x += FontPx * Sx.K * 0.28f + Tracking; continue; }
                    string s1 = ch.ToString();
                    TextRenderer.DrawText(e.Graphics, s1, font, new Point((int)Math.Round(x), r.Y), fc,
                        TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine | TextFormatFlags.Top);
                    x += e.Graphics.MeasureString(s1, font, 10000, fmt).Width + Tracking;
                }
            }
            return;
        }

        string text = StartEllipsis ? FitStart(Text, r.Width) : Text;
        TextFormatFlags flags = Flags();
        if (StartEllipsis) flags = (flags & ~TextFormatFlags.WordBreak) | TextFormatFlags.SingleLine;
        TextRenderer.DrawText(e.Graphics, text, font, r, fc, flags);
    }
}

/// <summary>
/// .card / .warn-box / plain rounded panel — rounded panel with a 1px
/// border; for the status card the border colour reacts to state
/// (ok=green, error=red).
/// </summary>
public class SpidxCard : Panel
{
    private readonly CardKind myKind;
    private CardState myState = CardState.Normal;
    private double myPulse = 1;
    private readonly Func<double, bool> myStep;
    public int Radius = 11;

    public SpidxCard(CardKind kind)
    {
        myKind = kind;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = Sx.Bg;
        myStep = Step;
    }

    public void SetState(CardState state)
    {
        myState = state;
        Invalidate();
    }

    /// <summary>@keyframes pulse (opacity .75 -> 1 over .3s) on status changes.</summary>
    public void Pulse()
    {
        if (!IsHandleCreated) return;
        myPulse = 0;
        SpidxAnim.Run(myStep);
    }

    private bool Step(double dt)
    {
        if (IsDisposed) return false;
        myPulse = Math.Min(1, myPulse + dt / 300.0);
        Invalidate();
        return myPulse < 1;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(BackColor);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);

        Color fill = myKind == CardKind.Warn ? Sx.WarnBg : Sx.Surface;
        Color border = myKind == CardKind.Warn
            ? Sx.WarnBorder
            : (myState == CardState.Ok ? Sx.Ok : myState == CardState.Error ? Sx.Err : Sx.Line);

        double ease = 1 - (1 - myPulse) * (1 - myPulse);
        double opacity = 0.75 + 0.25 * ease;
        if (myPulse < 1)
        {
            fill = Sx.Fade(fill, 1.0);
            fill = Sx.Blend(fill.A == 255 ? fill : Sx.Surface, Sx.Bg, opacity);
            border = Sx.Fade(border, opacity);
        }

        using (GraphicsPath path = Sx.RoundedRect(bounds, Sx.S(Radius)))
        {
            using (SolidBrush brush = new SolidBrush(fill)) g.FillPath(brush, path);
            using (Pen pen = new Pen(border, 1f)) g.DrawPath(pen, path);
        }
    }
}

/// <summary>
/// One button class for every button kind in the panel:
/// .btn (Primary) / .btn.secondary (Secondary, 1.5px border) /
/// .batch-actions button (Small, SmallDanger) / .tab-btn (Tab, IsActive) /
/// .lb-refresh (Toolbar). Disabled = opacity .55 like .btn:disabled.
/// </summary>
public class SpidxButton : Button
{
    private static readonly Color AccentPressed = Color.FromArgb(9, 111, 216);

    private struct Pal { public Color Fill, Border, Text; }

    private SpidxBtnKind myKind = SpidxBtnKind.Primary;
    private bool myActive;
    private bool myIsHovering;
    private bool myIsPressed;
    private double myHoverT;
    private double myActiveT;
    private readonly Func<double, bool> myStep;

    public SpidxButton()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        BackColor = Sx.Bg;
        Cursor = Cursors.Hand;
        myStep = Step;
        ApplyFont();
    }

    public SpidxBtnKind Kind
    {
        get { return myKind; }
        set { myKind = value; ApplyFont(); Invalidate(); }
    }

    /// <summary>Tab kind: active tab. Changes cross-fade (transition .15s).</summary>
    public bool IsActive
    {
        get { return myActive; }
        set
        {
            if (myActive == value) return;
            myActive = value;
            if (IsHandleCreated) SpidxAnim.Run(myStep); else myActiveT = value ? 1 : 0;
            Invalidate();
        }
    }

    private void ApplyFont()
    {
        switch (myKind)
        {
            case SpidxBtnKind.Primary:
            case SpidxBtnKind.Secondary: Font = Sx.Fnt(12.5f, 700); break;
            case SpidxBtnKind.Small:
            case SpidxBtnKind.SmallDanger: Font = Sx.Fnt(11f, 600); break;
            case SpidxBtnKind.Tab: Font = Sx.Fnt(11.5f, 600); break;
            default: Font = Sx.Fnt(11f, 400); break;
        }
    }

    private bool Step(double dt)
    {
        if (IsDisposed) return false;
        double d = dt / 150.0;
        double th = (myIsHovering && Enabled) ? 1 : 0;
        double ta = myActive ? 1 : 0;
        myHoverT = SpidxAnim.Approach(myHoverT, th, d);
        myActiveT = SpidxAnim.Approach(myActiveT, ta, d);
        Invalidate();
        return myHoverT != th || myActiveT != ta;
    }

    protected override void OnMouseEnter(EventArgs e) { myIsHovering = true; SpidxAnim.Run(myStep); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { myIsHovering = false; myIsPressed = false; SpidxAnim.Run(myStep); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs mevent) { myIsPressed = true; Invalidate(); base.OnMouseDown(mevent); }
    protected override void OnMouseUp(MouseEventArgs mevent) { myIsPressed = false; Invalidate(); base.OnMouseUp(mevent); }
    protected override void OnEnabledChanged(EventArgs e) { SpidxAnim.Run(myStep); Invalidate(); base.OnEnabledChanged(e); }
    protected override bool ShowFocusCues { get { return false; } }

    private Pal GetPal(bool hov, bool active)
    {
        Pal p = new Pal();
        p.Border = Sx.Line;
        switch (myKind)
        {
            case SpidxBtnKind.Primary:
                p.Fill = hov ? Sx.Brighten(Sx.Accent, 1.12) : Sx.Accent;
                p.Text = Color.White;
                p.Border = Color.Transparent;
                break;
            case SpidxBtnKind.Secondary:
                p.Fill = hov ? Sx.Brighten(Sx.SurfaceAlt, 1.12) : Sx.SurfaceAlt;
                p.Text = Sx.Text;
                break;
            case SpidxBtnKind.Small:
                p.Fill = Sx.SurfaceAlt;
                p.Text = hov ? Sx.Text : Sx.Dim;
                break;
            case SpidxBtnKind.SmallDanger:
                p.Fill = Sx.SurfaceAlt;
                p.Text = hov ? Sx.Err : Sx.Dim;
                p.Border = hov ? Color.FromArgb(102, 255, 90, 82) : Sx.Line;
                break;
            case SpidxBtnKind.Tab:
                if (active) { p.Fill = Sx.Accent; p.Text = Color.White; p.Border = Color.Transparent; }
                else { p.Fill = hov ? Sx.SurfaceAlt : Sx.Surface; p.Text = hov ? Sx.Text : Sx.Dim; }
                break;
            default: // Toolbar
                p.Fill = hov ? Sx.Brighten(Sx.SurfaceAlt, 1.15) : Sx.SurfaceAlt;
                p.Text = Sx.Text;
                break;
        }
        return p;
    }

    private static Pal Mix(Pal a, Pal b, double t)
    {
        Pal p = new Pal();
        p.Fill = Sx.Lerp(a.Fill, b.Fill, t);
        p.Border = Sx.Lerp(a.Border, b.Border, t);
        p.Text = Sx.Lerp(a.Text, b.Text, t);
        return p;
    }

    protected override void OnPaint(PaintEventArgs pevent)
    {
        Graphics g = pevent.Graphics;
        g.Clear(BackColor);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);

        bool en = Enabled;
        bool primarySecondary = myKind == SpidxBtnKind.Primary || myKind == SpidxBtnKind.Secondary;
        int radius = Sx.S(primarySecondary ? 10 : 8);
        float borderWidth = myKind == SpidxBtnKind.Secondary ? 1.5f : 1f;

        Pal inactive = Mix(GetPal(false, false), GetPal(true, false), myHoverT);
        Pal active = Mix(GetPal(false, true), GetPal(true, true), myHoverT);
        Pal pal = Mix(inactive, active, myActiveT);
        Color fill = pal.Fill, border = pal.Border, text = pal.Text;
        if (myKind == SpidxBtnKind.Primary && myIsPressed && en) fill = AccentPressed;

        if (!en)
        {
            fill = Sx.Fade(fill, 0.55);
            border = Sx.Fade(border, 0.55);
            text = Sx.Blend(text, Sx.Bg, 0.55);
        }

        using (GraphicsPath path = Sx.RoundedRect(bounds, radius))
        {
            using (SolidBrush brush = new SolidBrush(fill)) g.FillPath(brush, path);
            if (border.A > 0) using (Pen pen = new Pen(border, borderWidth)) g.DrawPath(pen, path);
        }

        Rectangle textBounds = bounds;
        if (myIsPressed && en && primarySecondary) textBounds.Offset(0, 1);
        TextRenderer.DrawText(g, Text, Font, textBounds, text,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding
            | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
    }
}

/// <summary>
/// .seg button — the batch-count (1/2/3) segmented toggle. Inactive =
/// surface + dim text; active = translucent accent fill + accent border
/// + white text. Disabled = opacity .35.
/// </summary>
public class SpidxSegButton : Button
{
    private bool myActive;
    private bool myIsHovering;
    private double myHoverT;
    private double myActiveT;
    private readonly Func<double, bool> myStep;

    public SpidxSegButton()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        BackColor = Sx.Bg;
        Font = Sx.Fnt(11.5f, 600);
        Cursor = Cursors.Hand;
        myStep = Step;
    }

    public bool IsActive
    {
        get { return myActive; }
        set
        {
            if (myActive == value) return;
            myActive = value;
            if (IsHandleCreated) SpidxAnim.Run(myStep); else myActiveT = value ? 1 : 0;
            Invalidate();
        }
    }

    private bool Step(double dt)
    {
        if (IsDisposed) return false;
        double d = dt / 150.0;
        double th = (myIsHovering && Enabled) ? 1 : 0;
        double ta = myActive ? 1 : 0;
        myHoverT = SpidxAnim.Approach(myHoverT, th, d);
        myActiveT = SpidxAnim.Approach(myActiveT, ta, d);
        Invalidate();
        return myHoverT != th || myActiveT != ta;
    }

    protected override void OnMouseEnter(EventArgs e) { myIsHovering = true; SpidxAnim.Run(myStep); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { myIsHovering = false; SpidxAnim.Run(myStep); base.OnMouseLeave(e); }
    protected override void OnEnabledChanged(EventArgs e) { SpidxAnim.Run(myStep); Invalidate(); base.OnEnabledChanged(e); }
    protected override bool ShowFocusCues { get { return false; } }

    protected override void OnPaint(PaintEventArgs pevent)
    {
        Graphics g = pevent.Graphics;
        g.Clear(BackColor);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);
        bool en = Enabled;

        // inactive -> active, with the hover tint mixed in for the inactive state
        Color fillOff = Sx.Surface;
        Color borderOff = Sx.Lerp(Sx.Line, Color.FromArgb(74, 74, 85), myHoverT);
        Color textOff = Sx.Lerp(Sx.Dim, Sx.Text, myHoverT);
        Color fill = Sx.Lerp(fillOff, Sx.SegActiveBg, myActiveT);
        Color border = Sx.Lerp(borderOff, Sx.Accent, myActiveT);
        Color textColor = Sx.Lerp(textOff, Color.White, myActiveT);

        if (!en)
        {
            fill = Sx.Fade(fill, 0.35);
            border = Sx.Fade(border, 0.35);
            textColor = Sx.Blend(textColor, Sx.Bg, 0.35);
        }

        using (GraphicsPath path = Sx.RoundedRect(bounds, Sx.S(8)))
        {
            using (SolidBrush brush = new SolidBrush(fill)) g.FillPath(brush, path);
            using (Pen pen = new Pen(border, 1f)) g.DrawPath(pen, path);
        }
        TextRenderer.DrawText(g, Text, Font, bounds, textColor,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
    }
}

/// <summary>
/// Small rounded pill: .tier-badge (9px 700, padding 3px 6px, radius 5)
/// and .file-thumb (8.5px 700, 30x30, radius 7).
/// </summary>
public class SpidxBadge : Control
{
    public int Radius = 5;
    public float FontPx = 9f;
    public int Weight = 700;

    private string myText = "";
    private Color myBg = Sx.TierDefaultBg;
    private Color myFg = Sx.TierDefaultText;

    public SpidxBadge()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = Sx.Bg;
    }

    public void Configure(string text, Color bg, Color fg)
    {
        myText = text ?? "";
        myBg = bg;
        myFg = fg;
        Invalidate();
    }

    public void SetTier(string tier, long trialDaysRemaining)
    {
        string text = (tier ?? "").ToUpperInvariant() + (trialDaysRemaining > 0 ? " (" + trialDaysRemaining + "D)" : "");
        Color bg, fg;
        switch ((tier ?? "").ToLowerInvariant())
        {
            case "pro": bg = Sx.TierProBg; fg = Sx.TierProText; break;
            case "dev": bg = Sx.TierDevBg; fg = Sx.TierDevText; break;
            case "tester": bg = Sx.TierTesterBg; fg = Sx.TierTesterText; break;
            default: bg = Sx.TierDefaultBg; fg = Sx.TierDefaultText; break;
        }
        Configure(text, bg, fg);
    }

    /// <summary>Text width + 6px padding on each side (like the CSS padding: 3px 6px).</summary>
    public int PreferredWidth()
    {
        int w = TextRenderer.MeasureText(myText, Sx.Fnt(FontPx, Weight), new Size(100000, 100),
            TextFormatFlags.NoPadding | TextFormatFlags.SingleLine).Width;
        return w + Sx.S(12) + 1;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(BackColor);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);

        using (GraphicsPath path = Sx.RoundedRect(bounds, Sx.S(Radius)))
        using (SolidBrush brush = new SolidBrush(myBg))
        {
            g.FillPath(brush, path);
        }

        TextRenderer.DrawText(g, myText, Sx.Fnt(FontPx, Weight), bounds, myFg,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
    }
}

/// <summary>
/// .mark — 22x22 gradient square (linear-gradient(160deg, #0a84ff, #0060df))
/// with a bold white "S".
/// </summary>
public class SpidxBrandMark : Control
{
    public SpidxBrandMark()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = Sx.Bg;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(BackColor);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);

        // CSS 160deg = pointing almost straight down, slightly right.
        // GDI+ angles are measured clockwise from "left to right", so that is 70deg.
        using (GraphicsPath path = Sx.RoundedRect(bounds, Sx.S(7)))
        using (LinearGradientBrush gradient = new LinearGradientBrush(
                   new Rectangle(0, 0, Width, Height), Color.FromArgb(10, 132, 255), Color.FromArgb(0, 96, 223), 70f))
        {
            g.FillPath(gradient, path);
        }

        TextRenderer.DrawText(g, "S", Sx.Fnt(11f, 700), bounds, Color.White,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
    }
}

/// <summary>
/// .prog-track / .prog-fill — 5px progress bar, green when done.
/// </summary>
public class SpidxProgressBar : Control
{
    private double myShown;
    private double myTarget;
    private bool myDone;
    private bool myIndeterminate;
    private double myPhase;
    private readonly Func<double, bool> myStep;

    public SpidxProgressBar()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = Sx.Bg;
        myStep = Step;
    }

    /// <summary>width transition (.35s ease) towards percent; going backwards snaps.</summary>
    public void SetPercent(int percent, bool done)
    {
        myIndeterminate = false;
        myTarget = Math.Max(0, Math.Min(100, percent));
        myDone = done;
        if (myTarget < myShown || !IsHandleCreated) myShown = myTarget;
        else SpidxAnim.Run(myStep);
        Invalidate();
    }

    /// <summary>.prog-fill.indeterminate — 38% bar sliding across the track.</summary>
    public void SetIndeterminate(bool on)
    {
        myIndeterminate = on;
        myDone = false;
        if (on && IsHandleCreated) { myPhase = 0; SpidxAnim.Run(myStep); }
        Invalidate();
    }

    private bool Step(double dt)
    {
        if (IsDisposed) return false;
        if (myIndeterminate)
        {
            myPhase = (myPhase + dt / 1100.0) % 1.0;
            Invalidate();
            return true;
        }
        double diff = myTarget - myShown;
        if (Math.Abs(diff) < 0.3) { myShown = myTarget; Invalidate(); return false; }
        myShown += diff * Math.Min(1.0, dt / 110.0);
        Invalidate();
        return true;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(BackColor);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);
        int radius = Height / 2;

        using (GraphicsPath trackPath = Sx.RoundedRect(bounds, radius))
        {
            using (SolidBrush trackBrush = new SolidBrush(Color.FromArgb(31, 255, 255, 255)))
            {
                g.FillPath(trackBrush, trackPath);
            }

            if (myIndeterminate)
            {
                double p = myPhase;
                double eased = p < 0.5 ? 2 * p * p : 1 - Math.Pow(-2 * p + 2, 2) / 2;
                int w = (int)(bounds.Width * 0.38);
                int x = (int)(-w + eased * (bounds.Width + w));
                g.SetClip(trackPath);
                using (GraphicsPath fp = Sx.RoundedRect(new Rectangle(x, 0, w, bounds.Height), radius))
                using (SolidBrush fb = new SolidBrush(Sx.Accent))
                {
                    g.FillPath(fb, fp);
                }
                g.ResetClip();
                return;
            }
        }

        if (myShown <= 0) return;
        int fillWidth = Math.Max(Height, (int)(bounds.Width * (myShown / 100.0)));
        Rectangle fillBounds = new Rectangle(0, 0, Math.Min(fillWidth, bounds.Width), bounds.Height);
        using (GraphicsPath fillPath = Sx.RoundedRect(fillBounds, radius))
        using (SolidBrush fillBrush = new SolidBrush(myDone ? Sx.Ok : Sx.Accent))
        {
            g.FillPath(fillBrush, fillPath);
        }
    }
}

/// <summary>
/// .dots / .dot.filled — batch collection progress dots (accent-2 when filled).
/// </summary>
public class SpidxBatchDots : Control
{
    private int myHave;
    private int myTarget = 1;

    public SpidxBatchDots()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = Sx.Bg;
    }

    public void SetProgress(int have, int target)
    {
        myHave = have;
        myTarget = Math.Max(1, target);
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(BackColor);
        g.SmoothingMode = SmoothingMode.AntiAlias;

        int dotSize = Sx.S(8);
        int gap = Sx.S(5);
        int totalWidth = myTarget * dotSize + (myTarget - 1) * gap;
        int startX = Math.Max(0, (Width - totalWidth) / 2);

        for (int i = 0; i < myTarget; i++)
        {
            Rectangle dotBounds = new Rectangle(startX + i * (dotSize + gap), 0, dotSize, dotSize);
            Color fill = i < myHave ? Sx.AccentAlt : Color.FromArgb(31, 255, 255, 255);
            using (SolidBrush brush = new SolidBrush(fill))
            {
                g.FillEllipse(brush, dotBounds);
            }
        }
    }
}

/// <summary>
/// input[type=text] / .lb-search — rounded (radius 8) surface field with a
/// 1px border that turns accent on focus. Wraps a borderless TextBox;
/// placeholder text uses the native cue banner (EM_SETCUEBANNER).
/// </summary>
public class SpidxInput : Control
{
    private readonly TextBox myBox = new TextBox();
    private bool myFocused;
    private string myCue = "";

    public SpidxInput()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = Sx.Bg;
        Height = Sx.S(30);
        Cursor = Cursors.IBeam;

        myBox.BorderStyle = BorderStyle.None;
        myBox.BackColor = Sx.Surface;
        myBox.ForeColor = Sx.Text;
        myBox.Font = Sx.Fnt(11.5f, 400);
        myBox.GotFocus += (s, e) => { myFocused = true; Invalidate(); };
        myBox.LostFocus += (s, e) => { myFocused = false; SyncBox(); Invalidate(); };
        myBox.TextChanged += (s, e) => { SyncBox(); Invalidate(); OnTextChanged(EventArgs.Empty); };
        Controls.Add(myBox);
        LayoutBox();
        SyncBox();
    }

    public override string Text
    {
        get { return myBox.Text; }
        set { myBox.Text = value ?? ""; }
    }

    /// <summary>Placeholder text, drawn by this control while the box is empty and unfocused.</summary>
    public string Cue
    {
        get { return myCue; }
        set { myCue = value ?? ""; Invalidate(); }
    }

    // The real TextBox is only shown while focused or non-empty; otherwise the
    // placeholder is painted directly (no dependency on EM_SETCUEBANNER /
    // comctl32 v6, which a host app's manifest may not enable).
    private void SyncBox()
    {
        bool show = myFocused || myBox.Text.Length > 0;
        if (myBox.Visible != show) myBox.Visible = show;
    }

    private void LayoutBox()
    {
        int h = myBox.PreferredHeight;
        myBox.SetBounds(Sx.S(10), Math.Max(0, (Height - h) / 2), Math.Max(10, Width - 2 * Sx.S(10)), h);
    }

    protected override void OnResize(EventArgs e) { base.OnResize(e); LayoutBox(); }
    protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); myBox.Enabled = Enabled; Invalidate(); }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (!Enabled) return;
        myBox.Visible = true;
        myBox.Focus();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(BackColor);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);
        using (GraphicsPath path = Sx.RoundedRect(bounds, Sx.S(8)))
        {
            using (SolidBrush brush = new SolidBrush(Sx.Surface)) g.FillPath(brush, path);
            using (Pen pen = new Pen(myFocused ? Sx.Accent : Sx.Line, 1f)) g.DrawPath(pen, path);
        }

        if (!myBox.Visible && myCue.Length > 0)
        {
            TextRenderer.DrawText(g, myCue, Sx.Fnt(11.5f, 400), new Rectangle(Sx.S(10), 0, Math.Max(10, Width - 2 * Sx.S(10)), Height), Sx.Faint,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
        }
    }
}

/// <summary>Dark colour table so the dropdown of SpidxSelect matches the panel.</summary>
public class SpidxMenuColors : ProfessionalColorTable
{
    public SpidxMenuColors() { UseSystemColors = false; }
    public override Color ToolStripDropDownBackground { get { return Sx.Surface; } }
    public override Color MenuBorder { get { return Sx.SurfaceAlt; } }
    public override Color MenuItemBorder { get { return Sx.SurfaceAlt; } }
    public override Color MenuItemSelected { get { return Sx.SurfaceAlt; } }
    public override Color MenuItemSelectedGradientBegin { get { return Sx.SurfaceAlt; } }
    public override Color MenuItemSelectedGradientEnd { get { return Sx.SurfaceAlt; } }
    public override Color ImageMarginGradientBegin { get { return Sx.Surface; } }
    public override Color ImageMarginGradientMiddle { get { return Sx.Surface; } }
    public override Color ImageMarginGradientEnd { get { return Sx.Surface; } }
}

/// <summary>
/// select — rounded surface box with a chevron; opens a dark dropdown.
/// Replaces the stock ComboBox (which can't be themed dark/rounded).
/// </summary>
public class SpidxSelect : Control
{
    private readonly List<string> myItems = new List<string>();
    private int mySelected = -1;
    private bool myOpen;
    private int myClosedAt = -10000;
    private SpidxDropList myDrop;

    /// <summary>The panel the drop-down list is drawn on (a child of the panel itself, not a popup window).</summary>
    public Control Host;

    public event EventHandler SelectedIndexChanged;

    public SpidxSelect()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = Sx.Bg;
        Cursor = Cursors.Hand;
        Font = Sx.Fnt(11.5f, 400);
        Height = Sx.S(29);
    }

    public void SetItems(params string[] items)
    {
        myItems.Clear();
        myItems.AddRange(items);
        if (mySelected >= myItems.Count) mySelected = -1;
        Invalidate();
    }

    public int SelectedIndex
    {
        get { return mySelected; }
        set
        {
            if (value == mySelected) return;
            mySelected = value;
            Invalidate();
            if (SelectedIndexChanged != null) SelectedIndexChanged(this, EventArgs.Empty);
        }
    }

    public string SelectedItem
    {
        get { return mySelected >= 0 && mySelected < myItems.Count ? myItems[mySelected] : null; }
    }

    public void CloseDropDown()
    {
        if (myDrop != null) myDrop.Close();
    }

    // The list is a normal child control of the panel (NOT a ContextMenuStrip /
    // popup window): VEGAS's dock host doesn't dismiss popup windows when you
    // click elsewhere, which left the old menu stuck open on screen.
    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left || !Enabled || Host == null) return;
        try
        {
            if (myDrop != null && myDrop.Visible) { myDrop.Close(); return; }
            // a click on this box while the list is open first closes it (outside-click
            // detection) — don't immediately re-open it for that same click
            if (Environment.TickCount - myClosedAt < 300) return;

            if (myDrop == null)
            {
                myDrop = new SpidxDropList();
                myDrop.ItemChosen += index => { try { SelectedIndex = index; } catch { } };
                myDrop.Dismissed += (s, a) => { myOpen = false; myClosedAt = Environment.TickCount; Invalidate(); };
                Host.Controls.Add(myDrop);
            }

            Point hostPoint = Host.PointToClient(PointToScreen(new Point(0, Height + Sx.S(2))));
            Rectangle bounds = new Rectangle(hostPoint.X, hostPoint.Y, Width, myDrop.PreferredHeight(myItems.Count));
            myDrop.Open(new List<string>(myItems), mySelected, bounds);
            myOpen = true;
            Invalidate();
        }
        catch { myOpen = false; Invalidate(); }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && myDrop != null) { try { myDrop.Dispose(); } catch { } myDrop = null; }
        base.Dispose(disposing);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(BackColor);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);
        bool en = Enabled;

        using (GraphicsPath path = Sx.RoundedRect(bounds, Sx.S(8)))
        {
            using (SolidBrush brush = new SolidBrush(Sx.Surface)) g.FillPath(brush, path);
            using (Pen pen = new Pen(myOpen ? Sx.Accent : Sx.Line, 1f)) g.DrawPath(pen, path);
        }

        string text = SelectedItem ?? "";
        TextRenderer.DrawText(g, text, Font, new Rectangle(Sx.S(9), 0, Width - Sx.S(9) - Sx.S(26), Height), en ? Sx.Text : Sx.Faint,
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);

        int cx = Width - Sx.S(15), cy = Height / 2;
        float kk = Sx.K;
        using (Pen chevron = new Pen(Sx.Dim, 1.5f))
        {
            chevron.StartCap = LineCap.Round;
            chevron.EndCap = LineCap.Round;
            g.DrawLines(chevron, new PointF[] { new PointF(cx - 3.5f * kk, cy - 1.5f * kk), new PointF(cx, cy + 2f * kk), new PointF(cx + 3.5f * kk, cy - 1.5f * kk) });
        }
    }
}

/// <summary>
/// The drop-down list of SpidxSelect: a rounded, dark list drawn as a child
/// of the panel. It closes itself on: choosing an item, any mouse click
/// outside it (detected by polling the real mouse-button state, which works
/// even though VEGAS's host never delivers outside clicks to us), and
/// switching tabs / resizing (the owner calls Close()).
/// </summary>
public class SpidxDropList : Control
{
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    private List<string> myItems = new List<string>();
    private int mySelected = -1;
    private int myHover = -1;
    private bool myPrevDown = true;
    private readonly Func<double, bool> myStep;

    public event Action<int> ItemChosen;
    public event EventHandler Dismissed;

    public SpidxDropList()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = Sx.Surface;
        Cursor = Cursors.Hand;
        Visible = false;
        myStep = Step;
    }

    private int ItemH { get { return Sx.S(32); } }
    private int Pad { get { return Sx.S(4); } }

    public int PreferredHeight(int count)
    {
        return count * ItemH + 2 * Pad + 2;
    }

    public void Open(List<string> items, int selected, Rectangle bounds)
    {
        myItems = items;
        mySelected = selected;
        myHover = -1;
        Bounds = bounds;
        using (GraphicsPath p = Sx.RoundedRect(new Rectangle(0, 0, Width, Height), Sx.S(8)))
        {
            Region = new System.Drawing.Region(p);
        }
        myPrevDown = true;   // the click that opened us may still be held
        Visible = true;
        BringToFront();
        Invalidate();
        SpidxAnim.Run(myStep);
    }

    public void Close()
    {
        if (!Visible) return;
        Visible = false;
        if (Dismissed != null) Dismissed(this, EventArgs.Empty);
    }

    private bool Step(double dt)
    {
        if (IsDisposed || !Visible) return false;
        // Left button just went down somewhere that is not this list -> dismiss.
        bool down = (GetAsyncKeyState(0x01) & 0x8000) != 0 || (GetAsyncKeyState(0x02) & 0x8000) != 0;
        if (down && !myPrevDown)
        {
            if (!RectangleToScreen(ClientRectangle).Contains(Cursor.Position))
            {
                Close();
                return false;
            }
        }
        myPrevDown = down;
        return true;
    }

    private int ItemAt(Point p)
    {
        int i = (p.Y - Pad - 1) / ItemH;
        if (p.Y < Pad + 1 || i < 0 || i >= myItems.Count) return -1;
        return i;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        int h = ItemAt(e.Location);
        if (h != myHover) { myHover = h; Invalidate(); }
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        myHover = -1;
        Invalidate();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        int i = ItemAt(e.Location);
        if (i < 0) return;
        Close();
        if (ItemChosen != null) ItemChosen(i);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(Sx.Surface);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        Font font = Sx.Fnt(11.5f, 400);

        for (int i = 0; i < myItems.Count; i++)
        {
            Rectangle row = new Rectangle(Pad + 1, Pad + 1 + i * ItemH, Width - 2 * (Pad + 1), ItemH);
            Color fill = Color.Empty;
            if (i == myHover) fill = Sx.SurfaceAlt;
            else if (i == mySelected) fill = Sx.RowSelected;
            if (!fill.IsEmpty)
            {
                using (GraphicsPath rp = Sx.RoundedRect(row, Sx.S(6)))
                using (SolidBrush b = new SolidBrush(fill)) g.FillPath(b, rp);
            }
            Color tc = i == mySelected ? Sx.AccentAlt : Sx.Text;
            TextRenderer.DrawText(g, myItems[i], font, new Rectangle(row.X + Sx.S(8), row.Y, row.Width - Sx.S(16), row.Height), tc,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
        }

        using (GraphicsPath border = Sx.RoundedRect(new Rectangle(0, 0, Width - 1, Height - 1), Sx.S(8)))
        using (Pen pen = new Pen(Color.FromArgb(70, 70, 74), 1f))
        {
            g.DrawPath(pen, border);
        }
    }
}

/// <summary>
/// .lb-table — the Leaderboard player list, drawn by hand so it looks like
/// the panel's HTML table: dark header (# / Nick / Points), 11px rows with
/// hairline separators, hover + selected tint, max 220px of rows then a
/// thin dark scrollbar (the panel's ::-webkit-scrollbar), wheel scrolling.
/// </summary>
public class SpidxLbList : Control
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetFocus();

    private static int HeadH { get { return Sx.S(31); } }       // padding 8 + 15 line + padding 8
    private static int RowH { get { return Sx.S(32); } }        // + 1px border-top
    private static int MaxRowsH { get { return Sx.S(220); } }   // .lb-rows { max-height: 220px }
    private static int EmptyH { get { return Sx.S(52); } }      // .lb-empty
    private static int ScrollW { get { return Sx.S(9); } }      // ::-webkit-scrollbar { width: 9px }
    private static int PadX { get { return Sx.S(10); } }
    private static int RankW { get { return Sx.S(22); } }
    private static int PtsW { get { return Sx.S(58); } }
    private static int Gap { get { return Sx.S(6); } }

    private List<string[]> myRows = new List<string[]>();
    private int myScroll;
    private int mySelected = -1;
    private int myHover = -1;
    private bool myThumbHover;
    private bool myDragging;
    private int myDragStartY;
    private int myDragStartScroll;
    private string myEmptyText = "No players";
    private double myClock = 1e9;                 // ms since the rows were set
    private readonly Func<double, bool> myStep;
    private const int AnimRows = 8;               // .lb-item:nth-child(n+9) { animation: none }
    private const double AnimMs = 160;            // .16s
    private const double AnimStagger = 20;

    public event EventHandler SelectedIndexChanged;

    public SpidxLbList()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer
                 | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
        BackColor = Sx.Bg;
        Height = HeadH + EmptyH + 2;
        myStep = StepAnim;
    }

    private bool StepAnim(double dt)
    {
        if (IsDisposed) return false;
        myClock += dt;
        Invalidate();
        return myClock < AnimRows * AnimStagger + AnimMs + 20;
    }

    private double RowT(int i)
    {
        if (i >= AnimRows) return 1;
        double t = (myClock - i * AnimStagger) / AnimMs;
        t = Math.Max(0, Math.Min(1, t));
        return 1 - (1 - t) * (1 - t);   // ease-out
    }

    public int SelectedIndex
    {
        get { return mySelected; }
        set { mySelected = value; Invalidate(); }
    }

    public int RowCount { get { return myRows.Count; } }

    public void SetRows(List<string[]> rows)
    {
        myRows = rows ?? new List<string[]>();
        mySelected = -1;
        myHover = -1;
        myScroll = 0;
        Height = HeadH + ViewH + 2;
        myClock = 1e9;
        if (myRows.Count > 0 && IsHandleCreated) { myClock = 0; SpidxAnim.Run(myStep); }
        Invalidate();
    }

    private int ContentH { get { return myRows.Count * RowH; } }
    private int ViewH { get { return myRows.Count == 0 ? EmptyH : Math.Min(ContentH, MaxRowsH); } }
    private bool NeedsScroll { get { return myRows.Count > 0 && ContentH > ViewH; } }
    private int MaxScroll { get { return Math.Max(0, ContentH - ViewH); } }
    private Rectangle RowsRect { get { return new Rectangle(1, 1 + HeadH, Math.Max(0, Width - 2), ViewH); } }

    private Rectangle ThumbRect()
    {
        Rectangle rr = RowsRect;
        int thumbH = Math.Max(Sx.S(28), (int)((double)ViewH * ViewH / Math.Max(1, ContentH)));
        int travel = Math.Max(1, ViewH - thumbH);
        int y = rr.Y + (MaxScroll == 0 ? 0 : (int)((double)myScroll / MaxScroll * travel));
        // 9px scrollbar with a 2px transparent "border" on each side = 5px visible thumb
        int inset = Sx.S(2);
        return new Rectangle(rr.Right - ScrollW + inset, y + 1, ScrollW - 2 * inset, thumbH - 2);
    }

    private int RowAt(Point p)
    {
        Rectangle rr = RowsRect;
        int rowW = rr.Width - (NeedsScroll ? ScrollW : 0);
        if (myRows.Count == 0 || !new Rectangle(rr.X, rr.Y, rowW, rr.Height).Contains(p)) return -1;
        int i = (p.Y - rr.Y + myScroll) / RowH;
        return (i >= 0 && i < myRows.Count) ? i : -1;
    }

    private void ClampScroll()
    {
        myScroll = Math.Max(0, Math.Min(MaxScroll, myScroll));
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (myDragging)
        {
            int travel = Math.Max(1, ViewH - ThumbRect().Height - 2);
            myScroll = myDragStartScroll + (int)((double)(e.Y - myDragStartY) * MaxScroll / travel);
            ClampScroll();
            Invalidate();
            return;
        }
        int hover = RowAt(e.Location);
        bool thumbHover = NeedsScroll && e.X >= RowsRect.Right - ScrollW && ThumbRect().Contains(new Point(ThumbRect().X, e.Y));
        if (hover != myHover || thumbHover != myThumbHover)
        {
            myHover = hover;
            myThumbHover = thumbHover;
            Invalidate();
        }
        Cursor = hover >= 0 ? Cursors.Hand : Cursors.Default;
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (myDragging) return;
        myHover = -1;
        myThumbHover = false;
        Cursor = Cursors.Default;
        Invalidate();
    }

    protected override void OnMouseEnter(EventArgs e)
    {
        base.OnMouseEnter(e);
        // WinForms only delivers the wheel to the focused control; take focus on
        // hover so the wheel works — unless the user is typing in a text box.
        try
        {
            Control focused = Control.FromChildHandle(GetFocus());
            if (!(focused is TextBox)) Focus();
        }
        catch { }
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;

        Rectangle rr = RowsRect;
        if (NeedsScroll && e.X >= rr.Right - ScrollW && e.Y >= rr.Y && e.Y < rr.Bottom)
        {
            Rectangle thumb = ThumbRect();
            if (e.Y >= thumb.Y && e.Y <= thumb.Bottom)
            {
                myDragging = true;
                myDragStartY = e.Y;
                myDragStartScroll = myScroll;
                Capture = true;
            }
            else
            {
                myScroll += e.Y < thumb.Y ? -ViewH : ViewH;
                ClampScroll();
                Invalidate();
            }
            return;
        }

        int i = RowAt(e.Location);
        if (i >= 0)
        {
            mySelected = i;
            Invalidate();
            if (SelectedIndexChanged != null) SelectedIndexChanged(this, EventArgs.Empty);
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (myDragging) { myDragging = false; Capture = false; Invalidate(); }
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        if (!NeedsScroll) return;
        myScroll -= (e.Delta / 120) * RowH * 3;
        ClampScroll();
        Invalidate();
    }

    private static void Cell(Graphics g, string text, Rectangle r, Color color, Font font, bool right)
    {
        TextFormatFlags f = TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix
                            | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | (right ? TextFormatFlags.Right : TextFormatFlags.Left);
        TextRenderer.DrawText(g, text ?? "", font, r, color, f);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.Clear(BackColor);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle outer = new Rectangle(0, 0, Width - 1, Height - 1);
        Font headFont = Sx.Fnt(11f, 700);
        Font rowFont = Sx.Fnt(11f, 400);

        using (GraphicsPath clip = Sx.RoundedRect(outer, Sx.S(10)))
        {
            g.SetClip(clip);

            // header (.lb-head)
            using (SolidBrush hb = new SolidBrush(Sx.SurfaceAlt)) g.FillRectangle(hb, 1, 1, Width - 2, HeadH);
            int headRight = Width - 1;
            int ptsX = headRight - PadX - PtsW;
            int nickX = 1 + PadX + RankW + Gap;
            Cell(g, "#", new Rectangle(1 + PadX, 1, RankW, HeadH), Sx.Dim, headFont, false);
            Cell(g, "Nick", new Rectangle(nickX, 1, Math.Max(10, ptsX - Gap - nickX), HeadH), Sx.Dim, headFont, false);
            Cell(g, "Points", new Rectangle(ptsX, 1, PtsW, HeadH), Sx.Dim, headFont, true);

            // rows (.lb-rows)
            Rectangle rr = RowsRect;
            g.SetClip(clip);
            g.IntersectClip(rr);

            if (myRows.Count == 0)
            {
                TextRenderer.DrawText(g, myEmptyText, Sx.Fnt(11.5f, 400), rr, Sx.Dim,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
            }
            else
            {
                int rowW = rr.Width - (NeedsScroll ? ScrollW : 0);
                int rowRight = rr.X + rowW;
                int rPtsX = rowRight - PadX - PtsW;
                int rNickX = rr.X + PadX + RankW + Gap;

                int first = Math.Max(0, myScroll / RowH);
                int last = Math.Min(myRows.Count - 1, (myScroll + ViewH) / RowH);
                for (int i = first; i <= last; i++)
                {
                    int y = rr.Y + i * RowH - myScroll;
                    Rectangle row = new Rectangle(rr.X, y, rowW, RowH);
                    double et = RowT(i);
                    int dx = (int)Math.Round(-Sx.S(3) * (1 - et));   // translateX(-3px) -> 0
                    Color bgUnder = Sx.Bg;

                    if (i == mySelected)
                        using (SolidBrush sb = new SolidBrush(Sx.RowSelected)) g.FillRectangle(sb, row);
                    else if (i == myHover)
                    {
                        bgUnder = Sx.SurfaceAlt;
                        using (SolidBrush hv = new SolidBrush(Sx.SurfaceAlt)) g.FillRectangle(hv, row);
                    }

                    using (Pen sep = new Pen(Sx.Fade(Sx.Line, et), 1f)) g.DrawLine(sep, row.X, y, row.Right, y);

                    string[] cells = myRows[i];
                    int ty = y + 1;
                    int th = RowH - 1;
                    Color tc = Sx.Blend(Sx.Text, bgUnder, et);
                    Cell(g, cells[0], new Rectangle(rr.X + PadX + dx, ty, RankW, th), tc, rowFont, false);
                    Cell(g, cells[1], new Rectangle(rNickX + dx, ty, Math.Max(10, rPtsX - Gap - rNickX), th), tc, rowFont, false);
                    Cell(g, cells[2], new Rectangle(rPtsX + dx, ty, PtsW, th), tc, rowFont, true);
                }

                if (NeedsScroll)
                {
                    Rectangle thumb = ThumbRect();
                    Color thumbColor = (myThumbHover || myDragging) ? Sx.Faint : Sx.SurfaceAlt;
                    using (GraphicsPath tp = Sx.RoundedRect(thumb, Sx.S(3)))
                    using (SolidBrush tb = new SolidBrush(thumbColor))
                    {
                        g.FillPath(tb, tp);
                    }
                }
            }

            g.ResetClip();
        }

        using (GraphicsPath border = Sx.RoundedRect(outer, Sx.S(10)))
        using (Pen pen = new Pen(Sx.Line, 1f))
        {
            g.DrawPath(pen, border);
        }
    }
}
