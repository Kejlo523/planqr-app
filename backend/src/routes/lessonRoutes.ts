import { Router } from 'express';
import { auditAction } from '../middlewares/auditMiddleware';
import { LessonController } from '../controllers/LessonController';
import { requireAdmin } from '../middlewares/authMiddleware';

const router = Router();
router.use(requireAdmin);

router.get('/messages/list', LessonController.getMessages);
router.get('/message/:roomId', LessonController.getMessage);
router.delete('/messages/clear', auditAction('MESSAGES', 'Wyczyszczono wiadomości sal'), LessonController.clearMessages);
router.delete('/message/delete/:roomId', auditAction('MESSAGES', 'Usunięto wiadomość sali', (req) => req.params.roomId), LessonController.deleteMessage);

export default router;
