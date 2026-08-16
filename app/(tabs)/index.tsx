import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuthStore } from '../../lib/auth';
import { CardLogo } from '../../components/CardLogo';
import { maskedPan } from '../../lib/cards';
import { CardRow, listCards } from '../../lib/db';
import { colors } from '../../lib/theme';

export default function MyCardsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const protectedDevice = useAuthStore((s) => s.protectedDevice);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionsFor, setActionsFor] = useState<CardRow | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      listCards().then((rows) => {
        if (active) setCards(rows);
      });
      return () => {
        active = false;
      };
    }, [])
  );

  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    };
  }, []);

  const selectMode = selected.size > 0;

  const toggleSelect = (cardId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) {
        next.delete(cardId);
      } else {
        next.add(cardId);
      }
      return next;
    });
  };

  const shareSelected = () => {
    if (!selectMode) return;
    router.push(`/share-card?ids=${[...selected].join(',')}`);
  };

  const startCardPress = (card: CardRow) => {
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      longPressTriggered.current = true;
      if (selectMode) {
        toggleSelect(card.id);
      } else {
        setActionsFor(card);
      }
    }, 400);
  };

  const finishCardPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleCardPress = (card: CardRow) => {
    if (longPressTriggered.current) {
      longPressTriggered.current = false;
      return;
    }
    if (selectMode) {
      toggleSelect(card.id);
    } else {
      router.push(`/card/${card.id}`);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
      <View style={styles.header}>
        {selectMode ? (
          <Text style={styles.title}>
            {selected.size} selected
          </Text>
        ) : (
          <Text style={styles.title}>My Cards</Text>
        )}
        <View style={styles.headerActions}>
          {selectMode ? (
            <>
              <Pressable
                onPress={() => setSelected(new Set())}
                hitSlop={12}
                accessibilityLabel="Cancel selection"
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.shareButton}
                onPress={shareSelected}
                accessibilityLabel="Share selected cards"
              >
                <Text style={styles.shareButtonText}>Share</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              style={styles.addButton}
              onPress={() => router.push('/add-card')}
              accessibilityLabel="Add card"
            >
              <Text style={styles.addButtonText}>+</Text>
            </Pressable>
          )}
        </View>
      </View>

      <FlatList
        data={cards}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No cards yet</Text>
            <Text style={styles.emptyText}>
              Add a card to keep its details encrypted on this phone.
            </Text>
          </View>
        }
        ListFooterComponent={
          cards.length > 0 && !selectMode ? (
            <Text style={styles.hint}>
              Long-press a card to share it, or select several to share together
            </Text>
          ) : null
        }
        renderItem={({ item }) => {
          const isSelected = selected.has(item.id);
          return (
            <Pressable
              style={[
                styles.cardTile,
                { backgroundColor: item.color },
                selectMode && !isSelected && styles.cardTileDim,
                isSelected && styles.cardTileSelected,
              ]}
              onPress={() => handleCardPress(item)}
              onPressIn={() => startCardPress(item)}
              onPressOut={finishCardPress}
            >
              {isSelected && (
                <View style={styles.checkBadge}>
                  <Text style={styles.checkText}>✓</Text>
                </View>
              )}
              <CardLogo network={item.network} width={42} />
              <Text style={styles.cardPan}>{maskedPan(item.last4)}</Text>
              <Text style={styles.cardNickname}>{item.nickname}</Text>
            </Pressable>
          );
        }}
      />

      {!protectedDevice && (
        <Text style={styles.devWarning}>
          Biometrics unavailable - vault unprotected (dev mode)
        </Text>
      )}

      {actionsFor && (
        <Modal
          transparent
          animationType="fade"
          visible
          onRequestClose={() => setActionsFor(null)}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>
                {actionsFor.nickname}
              </Text>
              <Text style={styles.modalSub}>{maskedPan(actionsFor.last4)}</Text>
              <Pressable
                style={styles.modalOption}
                onPress={() => {
                  router.push(`/share-card?id=${actionsFor.id}`);
                  setActionsFor(null);
                }}
              >
                <Text style={styles.modalOptionText}>Share</Text>
              </Pressable>
              <Pressable
                style={styles.modalOption}
                onPress={() => {
                  setSelected(new Set([actionsFor.id]));
                  setActionsFor(null);
                }}
              >
                <Text style={styles.modalOptionText}>Select</Text>
              </Pressable>
              <Pressable
                style={styles.modalCancel}
                onPress={() => setActionsFor(null)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    marginBottom: 16,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '700',
  },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonText: {
    color: '#FFFFFF',
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '600',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  cancelText: {
    color: colors.muted,
    fontSize: 15,
    fontWeight: '500',
  },
  shareButton: {
    backgroundColor: colors.accent,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  shareButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  cardTileDim: {
    opacity: 0.45,
  },
  cardTileSelected: {
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  checkBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 18,
  },
  hint: {
    color: colors.muted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 12,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 32,
    gap: 14,
  },
  cardTile: {
    borderRadius: 16,
    padding: 20,
    minHeight: 150,
    justifyContent: 'space-between',
    userSelect: 'none',
  },
  cardPan: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 2,
    userSelect: 'none',
  },
  cardNickname: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 15,
    fontWeight: '500',
    userSelect: 'none',
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 80,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
  },
  emptyText: {
    color: colors.muted,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    maxWidth: 280,
  },
  devWarning: {
    color: colors.muted,
    fontSize: 11,
    textAlign: 'center',
    paddingBottom: 12,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxWidth: 360,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  modalSub: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 4,
    marginBottom: 14,
    letterSpacing: 1,
  },
  modalOption: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginBottom: 8,
  },
  modalOptionText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '600',
  },
  modalCancel: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCancelText: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '600',
  },
});
