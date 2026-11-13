// The SDK's load-game handles for Sonic Mania, appended to the game's
// SonicMania/Objects/Menu/UISubHeading.c by scripts/build.sh (game library, so the
// game's own SaveGame, TimeAttackData and globals are in reach).
//
// web_mania_start_slot() replays what Mania Plus does when a save slot is picked on
// its own save select (UISubHeading_SaveButton_ActionCB), Mania Mode only: no Encore,
// no secrets (medal mods), no menu bookkeeping and no spinner — those belong to the
// menu scene, which isn't loaded. Mania writes SaveData.bin itself (SaveGame_SaveFile)
// and loads the scene in the callback, as it does there.
//
// Called from JS between frames (emscripten's main loop), so never mid-update.

#ifdef __EMSCRIPTEN__
#include <emscripten.h>

static void WebMania_SaveFileCB(bool32 success) { RSDK.LoadScene(); }

// The save file's state (STATUS_OK 200 when ready), asking Mania to load it first if
// nobody has yet. Plus only loads it in its menus, and SaveGame only exists once a scene
// using it is up (from the title screen on, not during the logos): until then this
// keeps returning 0, so the host lets the game run (muted) and polls.
EMSCRIPTEN_KEEPALIVE int32 web_mania_save_status(void)
{
    if (globals->saveLoaded != STATUS_OK && globals->saveLoaded != STATUS_CONTINUE)
        SaveGame_LoadFile(NULL);
    return globals->saveLoaded;
}

// How many characters a new game can pick: 6 with Plus (Mighty, Ray), else 4.
EMSCRIPTEN_KEEPALIVE int32 web_mania_characters(void) { return API.CheckDLC(DLC_PLUS) ? 6 : 4; }

// Start Mania Mode slot `slot` (0-7). An empty slot is a new game with `character`
// (0 Sonic & Tails, 1 Sonic, 2 Tails, 3 Knuckles, 4 Mighty, 5 Ray — the last two
// with Plus); a saved slot continues with its own character. 1 when started.
EMSCRIPTEN_KEEPALIVE int32 web_mania_start_slot(int32 slot, int32 character)
{
    if (globals->saveLoaded != STATUS_OK || slot < 0 || slot > 7)
        return 0;

    SaveRAM *saveRAM = (SaveRAM *)SaveGame_GetDataPtr(slot, false);
    bool32 isNewSave = saveRAM->saveState == SAVEGAME_BLANK;
    int32 maxCharacter = API.CheckDLC(DLC_PLUS) ? 5 : 3;

    TimeAttackData_Clear();
    globals->gameMode   = MODE_MANIA;
    globals->saveSlotID = slot;
    globals->medalMods  = 0;

    if (isNewSave) {
        if (character < 0 || character > maxCharacter)
            character = 0;
        memset(saveRAM, 0, 0x400);
        saveRAM->saveState         = SAVEGAME_INPROGRESS;
        saveRAM->characterID       = character;
        saveRAM->zoneID            = 0;
        saveRAM->lives             = 3;
        saveRAM->collectedEmeralds = 0;
        saveRAM->continues         = 0;
    }
    else {
        character = saveRAM->characterID;
        if (saveRAM->saveState == SAVEGAME_COMPLETE) {
            SaveGame_ClearCollectedSpecialRings();
            saveRAM->score    = 0;
            saveRAM->score1UP = 500000;
        }
    }
    saveRAM->medalMods = globals->medalMods;

    switch (character) {
        case 0:
        case 1: globals->playerID = ID_SONIC; break;
        case 2: globals->playerID = ID_TAILS; break;
        case 3: globals->playerID = ID_KNUCKLES; break;
        case 4: globals->playerID = ID_MIGHTY; break;
        case 5: globals->playerID = ID_RAY; break;
        default: break;
    }
    if (!character)
        globals->playerID |= ID_TAILS_ASSIST;

    if (isNewSave) {
        RSDK.SetScene("Cutscenes", "Angel Island Zone");
    }
    else {
        // A completed save starts where Mania's own select would without a zone picked.
        int32 zone = saveRAM->saveState == SAVEGAME_COMPLETE ? NO_SAVE_SLOT : saveRAM->zoneID;
        RSDK.SetScene("Mania Mode", "");
        SceneInfo->listPos += TimeAttackData_GetManiaListPos(zone, ACT_1, character);
    }

    SaveGame_SaveFile(WebMania_SaveFileCB);
    return 1;
}
#endif
