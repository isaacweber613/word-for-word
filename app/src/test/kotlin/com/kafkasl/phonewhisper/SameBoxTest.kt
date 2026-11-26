package com.kafkasl.phonewhisper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SameBoxTest {
    private val lastName = BoxId("com.example.form", "com.example.form:id/last_name", listOf(0, 1, 3), "Sign up")
    private val company = BoxId("com.example.form", "com.example.form:id/company", listOf(0, 1, 4), "Sign up")

    @Test fun theSameBoxMadeAgainAfterTheScreenTurned() {
        // The landscape layout can put it elsewhere; its ID still says which box it is.
        assertEquals(1, SameBox.find(lastName, listOf(company, lastName.copy(path = listOf(0, 2, 3))), remade = true))
    }

    @Test fun neverAnotherBoxWithTheSameIdWhileTheScreenWasNotMadeAgain() {
        // Another chat's message box has the same ID: the person went to another screen, not turned the phone.
        assertNull(SameBox.find(lastName, listOf(lastName), remade = false))
    }

    @Test fun neverAnotherBoxOnTheSameScreen() {
        assertNull(SameBox.find(lastName, listOf(company), remade = true))
    }

    @Test fun neverABoxInAnotherAppOrWindow() {
        assertNull(SameBox.find(lastName, listOf(lastName.copy(app = "com.other")), remade = true))
        assertNull(SameBox.find(lastName, listOf(lastName.copy(window = "Settings")), remade = true))
        // A window title Android didn't give (Android 6) doesn't count against it.
        assertEquals(0, SameBox.find(lastName.copy(window = null), listOf(lastName), remade = true))
    }

    @Test fun aBoxWithoutAnIdByItsPlace() {
        val box = BoxId("com.example.notes", null, listOf(0, 0, 2), null)
        assertEquals(1, SameBox.find(box, listOf(box.copy(path = listOf(0, 0, 1)), box), remade = true))
        assertNull(SameBox.find(box, listOf(box.copy(path = listOf(0, 0, 1))), remade = true))
        assertNull(SameBox.find(box, listOf(box.copy(viewId = "com.example.notes:id/title")), remade = true))
        assertNull(SameBox.find(box.copy(path = null), listOf(box.copy(path = null)), remade = true))
    }

    @Test fun severalBoxesWithTheSameIdOnlyByPlace() {
        // A list where every row has its own box with one ID.
        val row = BoxId("com.example.shop", "com.example.shop:id/quantity", listOf(0, 5, 2, 1), "Cart")
        val other = row.copy(path = listOf(0, 5, 1, 1))
        assertEquals(1, SameBox.find(row, listOf(other, row), remade = true))
        assertNull(SameBox.find(row, listOf(other, other.copy(path = listOf(0, 5, 3, 1))), remade = true))
    }

    @Test fun anotherChatsBoxInTheSameWindowAfterTheTurn() {
        // Google Messages keeps its window through the turn; opening another chat then swaps in that chat's
        // box, with the same ID, in the same window. It is another chat, never the box made again.
        val chat = BoxId("com.google.android.apps.messaging", "com.google.android.apps.messaging:id/compose_message_text",
            listOf(0, 0, 3), "Messages", windowId = 41)
        assertNull(SameBox.find(chat, listOf(chat), remade = true))
        // An app that makes its screen anew for the turn shows the box in a new window.
        assertEquals(0, SameBox.find(chat, listOf(chat.copy(windowId = 57)), remade = true))
        // A window number Android didn't give doesn't count against it.
        assertEquals(0, SameBox.find(chat.copy(windowId = null), listOf(chat), remade = true))
    }

    @Test fun aBoxWithoutAnIdAsTheSameNumberedBoxWhenTheLayoutMoves() {
        // Google Contacts' new-contact form: turned, the photo goes beside the boxes, so "Company" (the third
        // text box, no view ID) sits elsewhere in the tree, in the activity's new window.
        val company = BoxId("com.google.android.contacts", null, listOf(0, 0, 1, 4, 0), "Contacts", windowId = 50, order = 2)
        val turned = listOf(0, 1, 2).map { company.copy(path = listOf(0, 1, 0, it, 0), windowId = 61, order = it) }
        assertEquals(2, SameBox.find(company, turned, remade = true))
        // The same number in the same window is another box the app put there, never the box made again.
        assertNull(SameBox.find(company, listOf(company.copy(windowId = 50)), remade = true))
        // The same place but another number is another box.
        assertNull(SameBox.find(company, listOf(company.copy(windowId = 61, order = 1)), remade = true))
    }
}
