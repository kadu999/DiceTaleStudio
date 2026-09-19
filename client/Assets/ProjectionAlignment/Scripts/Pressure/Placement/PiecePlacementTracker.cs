using System;
using System.Collections.Generic;
using UnityEngine;

namespace NuLight.ProjectionAlignment.Placement
{
    /// <summary>
    /// Turns raw pressure-mat contacts into stable "piece placed" / "piece lifted" edges for any
    /// game running on the rig. It maps every contact to a cell through
    /// <see cref="IPlacementSurface{TCell}"/>, confirms a cell after a continuous interval, owns
    /// those contacts so a resting miniature cannot hold the primary touch forever, and offers a
    /// deliberate press-to-confirm gesture on top.
    ///
    /// It is deliberately outside any rules layer: sensor truth must never become rule truth by
    /// itself. Broadcasting an event and committing a game action are two separate decisions —
    /// the game only acts when it is actually waiting for that piece.
    ///
    /// Unity cannot add an open generic component, so a game declares a one-line concrete
    /// subclass (see <see cref="GridPiecePlacementTracker"/> for a ready-made square-grid one).
    /// </summary>
    public class PiecePlacementTracker<TPiece, TCell> : MonoBehaviour where TPiece : class
    {
        [Header("Placement State")]
        [Tooltip("Continuous pressure time required before a cell enters Placed state.")]
        [Min(0f)] public float ConfirmationSeconds = 0.2f;
        [Range(0f, 1f)] public float MinimumNormalizedPressure = 0.05f;

        [Header("Press-To-Confirm")]
        [Tooltip("Required normalized pressure increase above the piece's resting baseline.")]
        [Range(0.01f, 1f)] public float PressureConfirmIncrease = 0.12f;
        [Tooltip("Absolute normalized pressure floor that a deliberate confirmation must reach.")]
        [Range(0.01f, 1f)] public float PressureConfirmMinimum = 0.20f;
        [Tooltip("How long the stronger pressure must remain above both thresholds.")]
        [Min(0f)] public float PressureConfirmHoldSeconds = 0.12f;
        [Tooltip("Slow upward baseline tracking prevents ordinary sensor drift becoming a press.")]
        [Min(0f)] public float PressureBaselineRisePerSecond = 0.08f;

        [Header("Sampling")]
        [Tooltip("Camera whose view maps board UV to the playing surface. Empty = Camera.main.")]
        public Camera SurfaceCamera;

        public event Action<PiecePlacementEvent<TPiece, TCell>> PieceLifted;
        public event Action<PiecePlacementEvent<TPiece, TCell>> PiecePlaced;
        public event Action<PiecePressureEvent<TPiece, TCell>> PiecePressureConfirmed;

        static readonly IEqualityComparer<TCell> Cells = EqualityComparer<TCell>.Default;

        readonly StablePresenceTracker<TCell> _presence = new StablePresenceTracker<TCell>(0.2f);
        readonly StablePressureIncreaseTracker<TCell> _pressureIncrease =
            new StablePressureIncreaseTracker<TCell>();
        readonly HashSet<TCell> _pressedCells = new HashSet<TCell>();
        readonly Dictionary<TCell, float> _cellPressures = new Dictionary<TCell, float>();

        // 同一批接触的第二种读数：**从单个接触起就不封顶**的合力（`BoardContact.pressureRatio`）。
        // 存在感只问「这格上有没有东西」，0..1 够用；按压确认问的是「比刚才更重了没有」，
        // 任何一层封顶都正好把这个信号铲平 —— 一枚棋子只出一个峰值接触，静置就已经 ~0.94，
        // 按到再重 `normalizedPressure` 也只到 1.0，而 baseline + 0.12 = 1.06。
        readonly Dictionary<TCell, float> _cellForces = new Dictionary<TCell, float>();
        readonly HashSet<TCell> _resyncCandidates = new HashSet<TCell>();
        readonly List<PiecePlacementBinding<TPiece, TCell>> _bindingBuffer =
            new List<PiecePlacementBinding<TPiece, TCell>>(16);
        readonly Dictionary<TPiece, TCell> _bindings = new Dictionary<TPiece, TCell>();
        readonly Dictionary<TCell, TPiece> _owners = new Dictionary<TCell, TPiece>();
        readonly Dictionary<TPiece, TCell> _pieceCells = new Dictionary<TPiece, TCell>();
        readonly HashSet<TPiece> _seenPieces = new HashSet<TPiece>();
        readonly List<TPiece> _pieceBuffer = new List<TPiece>(16);

        IPlacementPieceSource<TPiece, TCell> _pieces;
        IPlacementSurface<TCell> _surface;
        PressureInputRouter _pressureInput;
        ProjectionVirtualTouchscreen _touchscreen;
        Camera _camera;
        TPiece _guidedPiece;
        bool _guidedReadyForDrop;
        bool _wasAvailable;
        bool _forceResync = true;
        bool _resyncWindow;
        bool _pressureConfirmationEnabled;
        float _resyncWindowEnds;
        float _nextSourceSearch;

        /// <summary>True while real pressure hardware is reporting and the game accepts it.</summary>
        public bool Available { get; private set; }

        public TPiece GuidedPiece => _guidedPiece;
        public bool PressureConfirmationEnabled => _pressureConfirmationEnabled;

        protected IPlacementSurface<TCell> Surface => _surface;
        protected ProjectionVirtualTouchscreen Touchscreen => _touchscreen;

        public void Bind(IPlacementPieceSource<TPiece, TCell> pieces, IPlacementSurface<TCell> surface)
        {
            _pieces = pieces;
            _surface = surface;
            _forceResync = true;
            FindSources(force: true);
        }

        public void ResetForResync()
        {
            _forceResync = true;
            EndGuidedPlacement();
        }

        /// <summary>
        /// Arms press-to-confirm only during an explicit gameplay window. Entering the window
        /// re-baselines every placed piece at its current resting pressure, so an old heavy touch
        /// cannot confirm a step that just opened.
        /// </summary>
        public void SetPressureConfirmationEnabled(bool enabled)
        {
            if (_pressureConfirmationEnabled == enabled) return;
            _pressureConfirmationEnabled = enabled;
            _pressureIncrease.Reset();
            if (!enabled) return;

            float now = Time.unscaledTime;
            foreach (KeyValuePair<TCell, TPiece> entry in _owners)
            {
                if (!IsAlive(entry.Value)) continue;
                // No reading for this cell yet: leave it without a baseline rather than invent a
                // low one. `Sample` adopts the first real force it sees, which is the same
                // "re-baseline at the current resting pressure" this window is for; a made-up
                // floor would instead read the piece's ordinary weight as a deliberate press.
                if (!_cellForces.TryGetValue(entry.Key, out float pressure)) continue;
                _pressureIncrease.SetBaseline(entry.Key, pressure, now);
            }
        }

        /// <summary>
        /// Names the one piece the game is currently waiting on, so a cell that no rule piece
        /// occupies yet (the empty square a miniature is being moved to) can still be attributed.
        /// </summary>
        public void BeginGuidedPlacement(TPiece piece)
        {
            _guidedPiece = piece;
            _guidedReadyForDrop = IsAlive(piece) && !_pieceCells.ContainsKey(piece);
        }

        /// <summary>
        /// The game refused the placement this piece just reported — hand the claim back.
        ///
        /// Attribution is a guess: while a guided piece is in the air, the first cell that goes
        /// stable is credited to it, and on a pressure mat that can just as easily be a hand or the
        /// model's edge brushing the surface. If a refused guess keeps its claim, the piece stays
        /// "already placed somewhere": <see cref="ResolveOwner"/> then skips it on both paths, so
        /// every later drop of that piece resolves to nobody and is discarded without an event.
        /// The flow can never finish and the player has no way to see why.
        /// </summary>
        public void ReleasePiecePlacement(TPiece piece)
        {
            if (!IsAlive(piece)) return;
            if (_pieceCells.TryGetValue(piece, out TCell cell))
            {
                _pieceCells.Remove(piece);
                if (_owners.TryGetValue(cell, out TPiece owner) && ReferenceEquals(owner, piece))
                    _owners.Remove(cell);
            }
            if (ReferenceEquals(_guidedPiece, piece)) _guidedReadyForDrop = true;
        }

        public void EndGuidedPlacement()
        {
            _guidedPiece = null;
            _guidedReadyForDrop = false;
        }

        public bool IsPiecePlaced(TPiece piece)
            => IsAlive(piece) && _pieceCells.ContainsKey(piece);

        /// <summary>
        /// Which cell the sensor currently believes this piece occupies. This is the authoritative
        /// answer — a game's own idea of where a piece stands can lag or drift, and a caller that
        /// needs the physical cell (for example to point at a miniature that just left play) should
        /// ask here first and only fall back to its own record.
        /// </summary>
        public bool TryGetPieceCell(TPiece piece, out TCell cell)
        {
            if (IsAlive(piece)) return _pieceCells.TryGetValue(piece, out cell);
            cell = default;
            return false;
        }

        public bool IsPiecePlacedAt(TPiece piece, TCell cell)
            => IsAlive(piece)
               && _pieceCells.TryGetValue(piece, out TCell placed)
               && Cells.Equals(placed, cell);

        public bool IsCellPlaced(TCell cell) => _presence.IsStable(cell);

        /// <summary>
        /// Something is confirmed on this cell, but no live registered piece claims it. That is the
        /// signature of an object the game no longer knows about — most often a miniature that was
        /// removed from play and is still standing on the mat, where it keeps blocking the cell.
        /// A game can use it to ask the player to take that piece away; the flag clears by itself
        /// the moment the cell is lifted or a live piece takes ownership of it.
        /// </summary>
        public bool IsCellUnclaimed(TCell cell)
            => _presence.IsStable(cell)
               && (!_owners.TryGetValue(cell, out TPiece owner)
                   || !IsAlive(owner)
                   // A piece the source has stopped declaring is out of play even though its
                   // Unity object still exists (a defeated miniature is only deactivated). Without
                   // this, a corpse keeps "claiming" its cell and the game can never tell the
                   // player to take it off the board.
                   || !_bindings.ContainsKey(owner));

        public bool IsCellPlacedByOther(TCell cell, TPiece piece)
        {
            if (!_presence.IsStable(cell)) return false;
            return !_owners.TryGetValue(cell, out TPiece owner) || !ReferenceEquals(owner, piece);
        }

        /// <summary>
        /// Locks a stable occupied cell to the rule piece that currently owns that cell.
        /// This repairs the rare frame where pressure stability is already known but owner
        /// resolution has not caught up yet; a scripted sequence must not fall back to automation
        /// merely because that mapping was late.
        /// </summary>
        public bool TryClaimStablePlacement(TPiece piece, TCell cell)
        {
            if (!IsAlive(piece) || !_presence.IsStable(cell)) return false;
            // Only a piece the source currently declares may own a cell. `IsAlive` is a Unity-null
            // check, so a defeated miniature still passes it; without this guard a caller that
            // iterates its full roster can hand a dead piece ownership of the cell its physical
            // model is still sitting on, which silently cancels the "take it away" prompt.
            if (!_bindings.ContainsKey(piece)) return false;
            if (_owners.TryGetValue(cell, out TPiece owner)
                && IsAlive(owner) && !ReferenceEquals(owner, piece)) return false;
            if (_pieceCells.TryGetValue(piece, out TCell placed) && !Cells.Equals(placed, cell))
                return false;

            _owners[cell] = piece;
            _pieceCells[piece] = cell;
            return true;
        }

        protected virtual void OnEnable()
        {
            _forceResync = true;
            FindSources(force: true);
        }

        protected virtual void OnDisable()
        {
            if (_touchscreen != null)
                _touchscreen.ClearContactAcceptanceFilter(AcceptAsGenericTouch);
            Available = false;
            _wasAvailable = false;
        }

        protected virtual void Update()
        {
            FindSources(force: false);
            bool available = IsReferenceAlive(_pieces)
                && IsReferenceAlive(_surface)
                && _pressureInput != null
                && _touchscreen != null
                && _pieces.PlacementInputAllowed
                && !_touchscreen.Suspended
                // The editor mouse simulator is a generic pointer, not evidence that a
                // physical miniature occupies the cell under the cursor. Treating it as a
                // placement source makes a held click become "piece placed" after the configured
                // delay and disables that piece's normal click handling.
                && !_pressureInput.UsingSimulation
                && !string.Equals(_pressureInput.ActiveSourceName, "None", StringComparison.Ordinal);

            if (!available)
            {
                Available = false;
                if (_wasAvailable) EnterUnknown();
                _wasAvailable = false;
                return;
            }

            Available = true;
            if (!_wasAvailable || _forceResync) BeginResync();
            _wasAvailable = true;
            _forceResync = false;

            RefreshBindings();
            CollectPressedCells();
            _presence.ConfirmationSeconds = Mathf.Max(0f, ConfirmationSeconds);
            _presence.Sample(_pressedCells, Time.unscaledTime, OnCellPlaced, OnCellLifted);
            SamplePressureConfirmations();
            if (_resyncWindow && Time.unscaledTime >= _resyncWindowEnds)
            {
                _resyncWindow = false;
                // Only contacts that survived the whole recovery window count as a resync.
                // Leaving short-lived candidates behind would later brand a real placement on
                // the same cell as "already there", and gameplay ignores resync events.
                _resyncCandidates.Clear();
            }
        }

        void FindSources(bool force)
        {
            if (!force && _pressureInput != null && _touchscreen != null) return;
            if (!force && Time.unscaledTime < _nextSourceSearch) return;
            _nextSourceSearch = Time.unscaledTime + 1f;

            if (_pressureInput == null) _pressureInput = FindFirstObjectByType<PressureInputRouter>();
            var foundTouchscreen = _touchscreen != null
                ? _touchscreen
                : FindFirstObjectByType<ProjectionVirtualTouchscreen>();
            if (foundTouchscreen == _touchscreen)
            {
                if (force && _touchscreen != null)
                    _touchscreen.SetContactAcceptanceFilter(AcceptAsGenericTouch);
                return;
            }
            if (_touchscreen != null)
                _touchscreen.ClearContactAcceptanceFilter(AcceptAsGenericTouch);
            _touchscreen = foundTouchscreen;
            if (_touchscreen != null)
                _touchscreen.SetContactAcceptanceFilter(AcceptAsGenericTouch);
        }

        void BeginResync()
        {
            ClearStateWithoutEvents();
            _resyncWindow = true;
            _resyncWindowEnds = Time.unscaledTime + Mathf.Max(0f, ConfirmationSeconds) + 0.05f;
        }

        void EnterUnknown()
        {
            ClearStateWithoutEvents();
            _resyncWindow = false;
        }

        void ClearStateWithoutEvents()
        {
            _presence.Reset();
            _pressureIncrease.Reset();
            _pressedCells.Clear();
            _cellPressures.Clear();
            _cellForces.Clear();
            _resyncCandidates.Clear();
            _owners.Clear();
            _pieceCells.Clear();
            EndGuidedPlacement();
        }

        void RefreshBindings()
        {
            _bindingBuffer.Clear();
            _pieces.CollectPlacementPieces(_bindingBuffer);
            _seenPieces.Clear();
            for (int i = 0; i < _bindingBuffer.Count; i++)
            {
                PiecePlacementBinding<TPiece, TCell> binding = _bindingBuffer[i];
                if (!IsAlive(binding.Piece)) continue;
                _seenPieces.Add(binding.Piece);
                _bindings[binding.Piece] = binding.Cell;
            }

            _pieceBuffer.Clear();
            foreach (TPiece piece in _bindings.Keys) _pieceBuffer.Add(piece);
            for (int i = 0; i < _pieceBuffer.Count; i++)
            {
                TPiece piece = _pieceBuffer[i];
                if (IsAlive(piece) && _seenPieces.Contains(piece)) continue;
                _bindings.Remove(piece);
                if (_pieceCells.TryGetValue(piece, out TCell placed))
                {
                    _pieceCells.Remove(piece);
                    if (_owners.TryGetValue(placed, out TPiece owner) && ReferenceEquals(owner, piece))
                        _owners.Remove(placed);
                }
                if (ReferenceEquals(_guidedPiece, piece)) EndGuidedPlacement();
            }
        }

        void CollectPressedCells()
        {
            _pressedCells.Clear();
            _cellPressures.Clear();
            _cellForces.Clear();
            IReadOnlyList<BoardContact> contacts = _pressureInput.Contacts;
            for (int i = 0; i < contacts.Count; i++)
            {
                BoardContact contact = contacts[i];
                if (contact.normalizedPressure <= 0f) continue;
                if (!TryResolveCell(contact, out TCell cell)) continue;
                _cellPressures.TryGetValue(cell, out float pressure);
                _cellPressures[cell] = NormalizedPressureAccumulator.Add(
                    pressure, contact.normalizedPressure);
                _cellForces.TryGetValue(cell, out float force);
                _cellForces[cell] = NormalizedPressureAccumulator.AddUnclamped(
                    force, contact.pressureRatio);
            }

            foreach (KeyValuePair<TCell, float> entry in _cellPressures)
            {
                if (entry.Value < MinimumNormalizedPressure) continue;
                _pressedCells.Add(entry.Key);
                if (_resyncWindow) _resyncCandidates.Add(entry.Key);
            }
        }

        void SamplePressureConfirmations()
        {
            if (!_pressureConfirmationEnabled) return;

            _pressureIncrease.RequiredIncrease = Mathf.Max(0.01f, PressureConfirmIncrease);
            _pressureIncrease.MinimumPressure = Mathf.Clamp01(PressureConfirmMinimum);
            _pressureIncrease.HoldSeconds = Mathf.Max(0f, PressureConfirmHoldSeconds);
            _pressureIncrease.BaselineRisePerSecond = Mathf.Max(0f, PressureBaselineRisePerSecond);

            float now = Time.unscaledTime;
            foreach (KeyValuePair<TCell, float> entry in _cellForces)
            {
                if (!_presence.IsStable(entry.Key) || !_owners.ContainsKey(entry.Key)) continue;
                _pressureIncrease.Sample(entry.Key, entry.Value, now, OnPressureConfirmed);
            }
        }

        bool AcceptAsGenericTouch(BoardContact contact)
        {
            if (!Available || !TryResolveCell(contact, out TCell cell)) return true;
            return !_presence.IsStable(cell);
        }

        /// <summary>
        /// Board UV to a cell: through the virtual touchscreen into screen pixels, then a camera
        /// ray onto the playing surface. Override it for a game whose cells are defined directly
        /// in board UV instead of in world space.
        /// </summary>
        protected virtual bool TryResolveCell(BoardContact contact, out TCell cell)
        {
            cell = default;
            if (_touchscreen == null || _surface == null) return false;
            Camera camera = ResolveCamera();
            if (camera == null) return false;

            Vector2 screen = _touchscreen.BoardToScreenPixels(contact.boardUv);
            Ray ray = camera.ScreenPointToRay(screen);
            if (Mathf.Abs(ray.direction.y) < 1e-5f) return false;
            float t = (_surface.SurfaceY - ray.origin.y) / ray.direction.y;
            if (t <= 0f) return false;
            return _surface.TryGetCell(ray.GetPoint(t), out cell);
        }

        protected Camera ResolveCamera()
        {
            if (SurfaceCamera != null && SurfaceCamera.isActiveAndEnabled) return SurfaceCamera;
            if (_camera == null || !_camera.isActiveAndEnabled)
                _camera = Camera.main != null ? Camera.main : FindFirstObjectByType<Camera>();
            return _camera;
        }

        void OnCellPlaced(TCell cell, float stableDuration)
        {
            bool isResync = _resyncCandidates.Remove(cell);
            TPiece piece = ResolveOwner(cell);
            if (!IsAlive(piece)) return;

            _owners[cell] = piece;
            _pieceCells[piece] = cell;
            if (_pressureConfirmationEnabled
                && _cellForces.TryGetValue(cell, out float force))
                _pressureIncrease.SetBaseline(cell, force, Time.unscaledTime);
            if (ReferenceEquals(piece, _guidedPiece)) _guidedReadyForDrop = false;
            PiecePlaced?.Invoke(new PiecePlacementEvent<TPiece, TCell>(
                piece, cell, stableDuration, Time.unscaledTime, isResync));
        }

        void OnCellLifted(TCell cell)
        {
            _resyncCandidates.Remove(cell);
            _pressureIncrease.Remove(cell);
            if (!_owners.TryGetValue(cell, out TPiece piece) || !IsAlive(piece)) return;
            _owners.Remove(cell);
            if (_pieceCells.TryGetValue(piece, out TCell placed) && Cells.Equals(placed, cell))
                _pieceCells.Remove(piece);
            if (ReferenceEquals(piece, _guidedPiece)) _guidedReadyForDrop = true;
            PieceLifted?.Invoke(new PiecePlacementEvent<TPiece, TCell>(
                piece, cell, 0f, Time.unscaledTime, false));
        }

        void OnPressureConfirmed(TCell cell, float baseline, float confirmed)
        {
            if (!_pressureConfirmationEnabled) return;
            if (!_owners.TryGetValue(cell, out TPiece piece) || !IsAlive(piece)) return;
            PiecePressureConfirmed?.Invoke(new PiecePressureEvent<TPiece, TCell>(
                piece, cell, baseline, confirmed, Time.unscaledTime));
        }

        TPiece ResolveOwner(TCell cell)
        {
            if (IsAlive(_guidedPiece) && _guidedReadyForDrop && !_owners.ContainsKey(cell))
                return _guidedPiece;

            foreach (KeyValuePair<TPiece, TCell> binding in _bindings)
            {
                TPiece piece = binding.Key;
                if (!IsAlive(piece) || !Cells.Equals(binding.Value, cell)) continue;
                if (_pieceCells.ContainsKey(piece)) continue;
                return piece;
            }
            return null;
        }

        /// <summary>
        /// Same destroyed-object guard for the two bound endpoints: a game whose board or
        /// controller was destroyed must go unavailable rather than keep sampling a dead
        /// reference.
        /// </summary>
        static bool IsReferenceAlive(object reference)
        {
            if (reference == null) return false;
            return !(reference is UnityEngine.Object unityObject) || unityObject != null;
        }

        /// <summary>
        /// Generic code compares references, which bypasses Unity's destroyed-object operator.
        /// Every piece null check goes through here so a destroyed miniature stops owning a cell.
        /// </summary>
        protected static bool IsAlive(TPiece piece)
        {
            if (piece == null) return false;
            return !(piece is UnityEngine.Object unityObject) || unityObject != null;
        }
    }
}
