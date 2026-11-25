package com.kafkasl.phonewhisper

/**
 * What tells a text box apart once Android has made its screen again. Turning the phone (or a change of
 * font size, dark mode or language) makes most apps build their screen anew, so the box a dictation started
 * in is gone and a new one stands in its place. [app] is its app, [viewId] its view ID (such as WhatsApp's
 * "com.whatsapp:id/entry"), [path] where it sits in its window (the child number at each level from the
 * top), and [window] its window's title. Any of them is null when Android didn't give it.
 */
data class BoxId(val app: String?, val viewId: String?, val path: List<Int>?, val window: String?)

object SameBox {
    /**
     * Which of [seen] (the boxes on the screen now) is [old] made again, or null. Only when the screen was
     * made again since the dictation started ([remade]); otherwise a box with the same ID is another box,
     * such as another chat's message box after the person opened that chat. It must be in the same app and,
     * when both titles are known, a window with the same title. A box with a view ID is found by it (the
     * turned layout may put it elsewhere), and among several with that ID only by its place; a box without
     * one only by its place. Until 2026-11-25 a box made again counted as gone, so its words went to the
     * clipboard and History instead.
     */
    fun find(old: BoxId, seen: List<BoxId>, remade: Boolean): Int? {
        if (!remade || old.app == null) return null
        val same = seen.indices.filter { i ->
            val box = seen[i]
            box.app == old.app &&
                (old.window == null || box.window == null || box.window == old.window) &&
                (if (old.viewId != null) box.viewId == old.viewId else box.viewId == null && old.path != null && box.path == old.path)
        }
        return same.singleOrNull() ?: same.singleOrNull { old.path != null && seen[it].path == old.path }
    }
}
