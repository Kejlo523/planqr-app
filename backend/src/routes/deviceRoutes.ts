import { Router } from 'express';
import { auditAction } from '../middlewares/auditMiddleware';
import { DeviceListController } from '../controllers/DeviceListController';
import { requireAdmin } from '../middlewares/authMiddleware';

const router = Router();
router.use(requireAdmin);

// Specific routes first
/**
 * @swagger
 * tags:
 *   name: Devices
 *   description: Device management
 */

/**
 * @swagger
 * /api/devices/validate:
 *   get:
 *     summary: Validate if a device exists by room and secretUrl
 *     tags: [Devices]
 *     parameters:
 *       - in: query
 *         name: room
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: secretUrl
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Device found
 *       404:
 *         description: Device not found
 */
router.get('/validate', DeviceListController.validateRoomAndSecretUrl);
router.get('/pending/by-code', DeviceListController.getPendingDeviceByCode);
router.get('/display-settings', DeviceListController.getDisplaySettings);
router.put('/display-settings', auditAction('TABLETS', 'Zapisano ustawienia ekranów'), DeviceListController.updateDisplaySettings);
router.get('/priority-messages', DeviceListController.getPriorityMessages);
router.post('/priority-messages/upload', DeviceListController.uploadPriorityMessageMedia);
router.post('/priority-messages/templates', auditAction('MESSAGES', 'Dodano szablon komunikatu'), DeviceListController.createPriorityMessageTemplate);
router.patch('/priority-messages/templates/:templateId', auditAction('MESSAGES', 'Edytowano szablon komunikatu', (req) => req.params.templateId), DeviceListController.updatePriorityMessageTemplate);
router.delete('/priority-messages/templates/:templateId', auditAction('MESSAGES', 'Usunięto szablon komunikatu', (req) => req.params.templateId), DeviceListController.deletePriorityMessageTemplate);
router.get('/priority-messages/schedules', DeviceListController.getPriorityMessageSchedules);
router.post('/priority-messages/schedules', auditAction('MESSAGES', 'Dodano harmonogram komunikatu'), DeviceListController.createPriorityMessageSchedule);
router.patch('/priority-messages/schedules/:scheduleId', auditAction('MESSAGES', 'Edytowano harmonogram komunikatu', (req) => req.params.scheduleId), DeviceListController.updatePriorityMessageSchedule);
router.delete('/priority-messages/schedules/:scheduleId', auditAction('MESSAGES', 'Usunięto harmonogram komunikatu', (req) => req.params.scheduleId), DeviceListController.deletePriorityMessageSchedule);
router.get('/priority-messages/presets', DeviceListController.getPriorityMessagePresets);
router.post('/priority-messages/presets', auditAction('MESSAGES', 'Dodano zestaw komunikatów'), DeviceListController.createPriorityMessagePreset);
router.patch('/priority-messages/presets/:presetId', auditAction('MESSAGES', 'Edytowano zestaw komunikatów', (req) => req.params.presetId), DeviceListController.updatePriorityMessagePreset);
router.delete('/priority-messages/presets/:presetId', auditAction('MESSAGES', 'Usunięto zestaw komunikatów', (req) => req.params.presetId), DeviceListController.deletePriorityMessagePreset);
router.post('/priority-messages/activate', auditAction('MESSAGES', 'Włączono komunikat na tabletach'), DeviceListController.activatePriorityMessage);
router.post('/priority-messages/clear', auditAction('MESSAGES', 'Wyłączono komunikat na tabletach'), DeviceListController.clearPriorityMessage);
router.patch('/display-settings/batch', auditAction('TABLETS', 'Zmieniono ustawienia grupy tabletów',
    (req) => Array.isArray(req.body?.deviceIds) ? 'Liczba tabletów: ' + req.body.deviceIds.length : undefined),
DeviceListController.batchUpdateDeviceDisplaySettings);
router.post('/reload-all', auditAction('TABLETS', 'Zlecono odświeżenie wszystkich tabletów'), DeviceListController.reloadAllTablets);
router.post('/:id/ban-ip', auditAction('TABLETS', 'Zablokowano adres tabletu'), DeviceListController.banDeviceIp);
router.post('/:id/request-display-profile', DeviceListController.requestDisplayProfile);
router.post('/:id/reload', auditAction('TABLETS', 'Zlecono odświeżenie tabletu'), DeviceListController.reloadDevice);
router.patch('/:id/display-settings', auditAction('TABLETS', 'Zmieniono ustawienia tabletu'), DeviceListController.updateDeviceDisplaySettings);

/**
 * @swagger
 * /api/devices:
 *   get:
 *     summary: Get all devices
 *     tags: [Devices]
 *     responses:
 *       200:
 *         description: List of devices
 */
router.get('/', DeviceListController.getDevices);

/**
 * @swagger
 * /api/devices/{id}:
 *   get:
 *     summary: Get a device by ID
 *     tags: [Devices]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Device details
 *       404:
 *         description: Device not found
 */
router.get('/:id', DeviceListController.getDevice);

/**
 * @swagger
 * /api/devices:
 *   post:
 *     summary: Create a new device
 *     tags: [Devices]
 *     requestBody:
 *       required: true
    *       content:
    *         application/json:
    *           schema:
    *             type: object
    *             properties:
    *               deviceClassroom:
    *                 type: string
 *     responses:
 *       201:
 *         description: Device created
 */
router.post('/', auditAction('TABLETS', 'Dodano tablet', (req) => req.body?.deviceClassroom), DeviceListController.createDevice);

/**
 * @swagger
 * /api/devices/{id}:
 *   put:
 *     summary: Update a device
 *     tags: [Devices]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       204:
 *         description: Device updated
 */
router.put('/:id', auditAction('TABLETS', 'Edytowano tablet'), DeviceListController.updateDevice);

/**
 * @swagger
 * /api/devices/{id}:
 *   delete:
 *     summary: Delete a device
 *     tags: [Devices]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       204:
 *         description: Device deleted
 */
router.delete('/:id', auditAction('TABLETS', 'Usunięto tablet'), DeviceListController.deleteDevice);

export default router;
