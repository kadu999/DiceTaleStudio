namespace DMGameLibrary
{
    /// <summary>
    /// What a game has to be able to do to run inside the library on the projection rig.
    ///
    /// A game loaded as an energy seed is not alone on the machine any more: an operator can
    /// drop the calibration layer over it mid-session, and the keyboard belongs to that
    /// operator, not to the players standing on the mat. Both are things only the game can
    /// honour, so they are asked for rather than imposed.
    ///
    /// Implement it on the game's own controller and leave both properties true/false as the
    /// standalone scene wants them; the host only writes them while the game is hosted, and
    /// puts them back on the way out.
    /// </summary>
    public interface IDMHostedGame
    {
        /// <summary>
        /// Stop reading the pointer, without pausing. Raised while the calibration layer is
        /// up so that stepping on a calibration marker cannot also play a move underneath it.
        /// </summary>
        bool InputSuspended { get; set; }

        /// <summary>
        /// Whether the game's own keyboard shortcuts are live. Lowered while hosted: on the
        /// rig the keyboard is the operator's console — R resets the calibration, H summons
        /// the operator panel, C calibrates — and a game that also answers those keys would
        /// fire on every one of them.
        /// </summary>
        bool KeyboardShortcutsEnabled { get; set; }
    }
}
