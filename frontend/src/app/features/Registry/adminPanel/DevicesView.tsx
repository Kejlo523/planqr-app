import { useEffect, useRef, useState } from "react";
import AdminPanelSearchField from "./AdminPanelSearchField";
import AdminDevicesTable from "./AdminDevicesTable";
import AdminPanelSection from "./AdminPanelSection";
import PendingDeviceAssignmentSection from "./PendingDeviceAssignmentSection";
import type {
  AdminPanelTheme,
  Device,
  DeviceSortColumn,
  DeviceSortState,
  PriorityMessageTemplate,
  Tone,
} from "./types";

interface DeviceCounts {
  all: number;
  online: number;
  offline: number;
  pending: number;
}

interface DevicesViewProps {
  adminTheme: AdminPanelTheme;
  activeDevices: Device[];
  pendingDevices: Device[];
  counts: DeviceCounts;
  loading: boolean;
  manualRefreshing: boolean;
  reloadingTablets: boolean;
  batchUpdating: boolean;
  batchThemeUpdating: boolean;
  batchBlackScreenUpdating: boolean;
  batchPriorityMessageUpdating: boolean;
  batchPriorityMessageClearing: boolean;
  priorityMessagesLoading: boolean;
  themeMutationDeviceId: number | null;
  blackScreenMutationDeviceId: number | null;
  batchThemeValue: Device["displayTheme"];
  batchBlackScreenValue: Device["blackScreenMode"];
  batchPriorityMessageTemplateId: string;
  priorityMessageTemplates: PriorityMessageTemplate[];
  selectedDeviceIds: number[];
  visibleDeviceIds: number[];
  searchTerm: string;
  sortState: DeviceSortState;
  pairingCode: string;
  pairingSuggestions: Device[];
  pairingDevice: Device | null;
  pairingRoom: string;
  pairingRoomSuggestions: string[];
  pairingShowRoomSuggestions: boolean;
  pairingLookingUp: boolean;
  pairingAssigning: boolean;
  pairingSearchingRooms: boolean;
  pairingCodeTone: Tone;
  pairingRoomTone: Tone;
  onSearchTermChange: (value: string) => void;
  onVisibleDeviceIdsChange: (ids: number[]) => void;
  onSortColumn: (column: DeviceSortColumn) => void;
  onDeleteSelectedDevices: () => void;
  onBatchThemeValueChange: (value: Device["displayTheme"]) => void;
  onBatchBlackScreenValueChange: (value: Device["blackScreenMode"]) => void;
  onBatchPriorityMessageTemplateChange: (value: string) => void;
  onApplyBatchTheme: () => void;
  onApplyBatchBlackScreen: () => void;
  onApplyBatchPriorityMessage: () => void;
  onClearBatchPriorityMessage: () => void;
  onToggleAllActiveDevices: (checked: boolean) => void;
  onToggleDeviceSelection: (deviceId: number) => void;
  onRefresh: () => void;
  onReloadTablets: () => void;
  onEditDevice: (device: Device) => void;
  onPreviewDevice: (device: Device) => void;
  onDeviceThemeChange: (device: Device, theme: Device["displayTheme"]) => void;
  onDeviceBlackScreenModeChange: (
    device: Device,
    blackScreenMode: Device["blackScreenMode"],
  ) => void;
  onDeleteDevice: (device: Device) => void;
  onPairingCodeChange: (value: string) => void;
  onPairingSuggestionSelect: (device: Device) => void;
  onLookupPairingDevice: () => void;
  onResetPairing: () => void;
  onPairingRoomChange: (value: string) => void;
  onPairingRoomSuggestionSelect: (room: string) => void;
  onAssignPairingDevice: () => void;
}

const DevicesView = ({
  adminTheme,
  activeDevices,
  pendingDevices,
  counts,
  loading,
  manualRefreshing,
  reloadingTablets,
  batchUpdating,
  batchThemeUpdating,
  batchBlackScreenUpdating,
  batchPriorityMessageUpdating,
  batchPriorityMessageClearing,
  priorityMessagesLoading,
  themeMutationDeviceId,
  blackScreenMutationDeviceId,
  batchThemeValue,
  batchBlackScreenValue,
  batchPriorityMessageTemplateId,
  priorityMessageTemplates,
  selectedDeviceIds,
  visibleDeviceIds,
  searchTerm,
  sortState,
  pairingCode,
  pairingSuggestions,
  pairingDevice,
  pairingRoom,
  pairingRoomSuggestions,
  pairingShowRoomSuggestions,
  pairingLookingUp,
  pairingAssigning,
  pairingSearchingRooms,
  pairingCodeTone,
  pairingRoomTone,
  onSearchTermChange,
  onVisibleDeviceIdsChange,
  onSortColumn,
  onDeleteSelectedDevices,
  onBatchThemeValueChange,
  onBatchBlackScreenValueChange,
  onBatchPriorityMessageTemplateChange,
  onApplyBatchTheme,
  onApplyBatchBlackScreen,
  onApplyBatchPriorityMessage,
  onClearBatchPriorityMessage,
  onToggleAllActiveDevices,
  onToggleDeviceSelection,
  onRefresh,
  onReloadTablets,
  onEditDevice,
  onPreviewDevice,
  onDeviceThemeChange,
  onDeviceBlackScreenModeChange,
  onDeleteDevice,
  onPairingCodeChange,
  onPairingSuggestionSelect,
  onLookupPairingDevice,
  onResetPairing,
  onPairingRoomChange,
  onPairingRoomSuggestionSelect,
  onAssignPairingDevice,
}: DevicesViewProps) => {
  const [assignmentCollapsed, setAssignmentCollapsed] = useState(true);
  const hasPairedDevices = activeDevices.length > 0;
  const hasPriorityTemplates = priorityMessageTemplates.length > 0;
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const selectedIds = new Set(selectedDeviceIds);
  const selectedCount = selectedDeviceIds.length;
  const visibleDevicesCount = visibleDeviceIds.length;
  const allActiveSelected =
    visibleDevicesCount > 0 && visibleDeviceIds.every((deviceId) => selectedIds.has(deviceId));
  const partiallySelected =
    selectedCount > 0 &&
    visibleDeviceIds.some((deviceId) => selectedIds.has(deviceId)) &&
    !allActiveSelected;
  const statusItems = [
    { label: "Wszystkie", value: counts.all, tone: "neutral" },
    { label: "Online", value: counts.online, tone: "success" },
    { label: "Offline", value: counts.offline, tone: "danger" },
    { label: "Oczekujące", value: counts.pending, tone: "warning" },
  ];

  const screenItems = [
    { label: "Motyw jasny", value: activeDevices.filter((device) => device.displayTheme === "light").length },
    { label: "Motyw ciemny", value: activeDevices.filter((device) => device.displayTheme === "dark").length },
    { label: "Czarny ekran", value: activeDevices.filter((device) => device.effectiveBlackScreen).length },
    { label: "Komunikat", value: activeDevices.filter((device) => device.priorityMessage?.enabled).length },
  ];

  const emptyStateTitle = loading ? "Ładowanie urządzeń" : "Brak sparowanych tabletów";
  const emptyStateDescription = loading
    ? "Trwa pobieranie listy tabletów."
    : "Przypisz tablet kodem, aby pojawił się tutaj.";

  useEffect(() => {
    if (pairingDevice) setAssignmentCollapsed(false);
  }, [pairingDevice]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = partiallySelected;
    }
  }, [partiallySelected]);

  const pairedDevicesTitle =
    selectedCount > 0 ? `Sparowane tablety (${selectedCount})` : "Sparowane tablety";

  const batchActionsContent = (
    <>
      <div className="admin-table__batch-control">
        <label className="admin-form-field admin-form-field--compact admin-table__header-field">
          <span className="admin-form-field__label">Motyw tabletu</span>
          <select
            className="admin-form-field__input admin-table__theme-select"
            aria-label="Batchowa zmiana trybu tabletu"
            value={batchThemeValue}
            onChange={(event) =>
              onBatchThemeValueChange(event.target.value as Device["displayTheme"])
            }
            disabled={batchThemeUpdating || !hasPairedDevices}
          >
            <option value="dark">Ciemny</option>
            <option value="light">Jasny</option>
          </select>
        </label>
        <button
          type="button"
          className="admin-button admin-button--secondary admin-button--small"
          onClick={onApplyBatchTheme}
          disabled={batchThemeUpdating || selectedCount === 0}
        >
          {batchThemeUpdating ? "Zapisywanie" : "Ustaw"}
        </button>
      </div>
      <div className="admin-table__batch-control">
        <label className="admin-form-field admin-form-field--compact admin-table__header-field">
          <span className="admin-form-field__label">Czarny ekran</span>
          <select
            className="admin-form-field__input admin-table__mode-select"
            aria-label="Batchowa zmiana czarnego ekranu"
            value={batchBlackScreenValue}
            onChange={(event) =>
              onBatchBlackScreenValueChange(event.target.value as Device["blackScreenMode"])
            }
            disabled={batchBlackScreenUpdating || !hasPairedDevices}
          >
            <option value="on">Włączony</option>
            <option value="off">Wyłączony</option>
            <option value="follow">Harmonogram</option>
          </select>
        </label>
        <button
          type="button"
          className="admin-button admin-button--secondary admin-button--small"
          onClick={onApplyBatchBlackScreen}
          disabled={batchBlackScreenUpdating || selectedCount === 0}
        >
          {batchBlackScreenUpdating ? "Zapisywanie" : "Ustaw"}
        </button>
      </div>
      <div className="admin-table__batch-control admin-table__batch-control--wide admin-table__batch-control--priority">
        <label className="admin-form-field admin-form-field--compact admin-table__header-field">
          <span className="admin-form-field__label">Komunikat priorytetowy</span>
          <select
            className="admin-form-field__input"
            aria-label="Komunikat priorytetowy"
            value={batchPriorityMessageTemplateId}
            onChange={(event) => onBatchPriorityMessageTemplateChange(event.target.value)}
            disabled={
              priorityMessagesLoading ||
              batchPriorityMessageUpdating ||
              !hasPriorityTemplates
            }
          >
            {!hasPriorityTemplates ? <option value="">Brak definicji</option> : null}
            {priorityMessageTemplates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="admin-button admin-button--primary admin-button--small"
          onClick={onApplyBatchPriorityMessage}
          disabled={
            batchPriorityMessageUpdating ||
            selectedCount === 0 ||
            !batchPriorityMessageTemplateId
          }
        >
          Włącz
        </button>
        <button
          type="button"
          className="admin-button admin-button--secondary admin-button--small"
          onClick={onClearBatchPriorityMessage}
          disabled={batchPriorityMessageClearing || selectedCount === 0}
        >
          Wyłącz
        </button>
      </div>
      <button
        type="button"
        className="admin-button admin-button--danger admin-button--small"
        onClick={onDeleteSelectedDevices}
        disabled={batchUpdating || selectedCount === 0}
      >
        <i className="fas fa-trash-alt" aria-hidden="true" />
        Usuń zaznaczone tablety
      </button>
    </>
  );

  return (
    <div className="admin-devices-view">
      <AdminPanelSection
        className="admin-devices-view__stats"
        title="Stan tabletów"
        actions={
          <>
            <button
              type="button"
              className="admin-button admin-button--secondary admin-button--small"
              onClick={onRefresh}
              disabled={manualRefreshing}
            >
              <i
                className={`fas fa-sync-alt ${manualRefreshing ? "fa-spin" : ""}`}
                aria-hidden="true"
              />
              Odśwież
            </button>
            <button
              type="button"
              className="admin-button admin-button--ghost admin-button--small"
              onClick={onReloadTablets}
              disabled={reloadingTablets || !hasPairedDevices}
            >
              <i
                className={`fas fa-bolt ${reloadingTablets ? "fa-spin" : ""}`}
                aria-hidden="true"
              />
              {reloadingTablets ? "Wysyłanie" : "Przeładuj tablety"}
            </button>
          </>
        }
      >
        <div
          className="admin-status-strip admin-status-strip--cols-4"
          aria-label="Status urządzeń"
        >
          {statusItems.map((item) => (
            <div
              key={item.label}
              className={`admin-status-strip__item admin-status-strip__item--${item.tone}`}
            >
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
        {hasPairedDevices && (
          <details className="admin-devices-view__screen-status">
            <summary>Stan ekranów</summary>
            <dl>
              {screenItems.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
          </details>
        )}
      </AdminPanelSection>

      <div className="admin-devices-view__overview admin-devices-view__overview--assignment">
        <PendingDeviceAssignmentSection
          pendingDevicesCount={pendingDevices.length}
          collapsible
          collapsed={assignmentCollapsed}
          codeValue={pairingCode}
          codeSuggestions={pairingSuggestions}
          selectedDevice={pairingDevice}
          roomValue={pairingRoom}
          roomSuggestions={pairingRoomSuggestions}
          showRoomSuggestions={pairingShowRoomSuggestions}
          isLookingUp={pairingLookingUp}
          isAssigning={pairingAssigning}
          isSearchingRooms={pairingSearchingRooms}
          codeTone={pairingCodeTone}
          roomTone={pairingRoomTone}
          onCodeChange={onPairingCodeChange}
          onCodeSuggestionSelect={onPairingSuggestionSelect}
          onLookup={onLookupPairingDevice}
          onReset={onResetPairing}
          onToggleCollapsed={() => setAssignmentCollapsed((collapsed) => !collapsed)}
          onRoomChange={onPairingRoomChange}
          onRoomSuggestionSelect={onPairingRoomSuggestionSelect}
          onAssign={onAssignPairingDevice}
        />
      </div>
      <AdminPanelSection
        className="admin-devices-view__list"
        title={pairedDevicesTitle}
        actions={
          hasPairedDevices ? (
            <div className="admin-devices-view__search">
              <AdminPanelSearchField
                label="Szukaj"
                placeholder="Sala, wydział, ID lub status"
                value={searchTerm}
                onChange={onSearchTermChange}
                compact
              />
            </div>
          ) : undefined
        }
      >
        {selectedCount > 0 && (
          <details className="admin-devices-view__selection">
            <summary>Operacje dla zaznaczonych ({selectedCount})</summary>
            <div className="admin-batch-panel">
              <div className="admin-table__batch-actions">{batchActionsContent}</div>
            </div>
          </details>
        )}
        {!hasPairedDevices ? (
          <div className="admin-empty-state">
            <h3>{emptyStateTitle}</h3>
            <p>{emptyStateDescription}</p>
          </div>
        ) : (
          <AdminDevicesTable
            adminTheme={adminTheme}
            caption="Lista aktywnych tabletów"
            devices={activeDevices}
            sortState={sortState}
            quickFilterText={searchTerm}
            selectAllRef={selectAllRef}
            allActiveSelected={allActiveSelected}
            selectedIds={selectedIds}
            themeMutationDeviceId={themeMutationDeviceId}
            blackScreenMutationDeviceId={blackScreenMutationDeviceId}
            batchThemeUpdating={batchThemeUpdating}
            batchBlackScreenUpdating={batchBlackScreenUpdating}
            onVisibleDeviceIdsChange={onVisibleDeviceIdsChange}
            onSortColumn={onSortColumn}
            onToggleAllActiveDevices={onToggleAllActiveDevices}
            onToggleDeviceSelection={onToggleDeviceSelection}
            onEditDevice={onEditDevice}
            onPreviewDevice={onPreviewDevice}
            onDeviceThemeChange={onDeviceThemeChange}
            onDeviceBlackScreenModeChange={onDeviceBlackScreenModeChange}
            onDeleteDevice={onDeleteDevice}
          />
        )}
      </AdminPanelSection>
    </div>
  );
};

export default DevicesView;
