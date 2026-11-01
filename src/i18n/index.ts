import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ca from './locales/ca.json';
import cs from './locales/cs.json';
import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import it from './locales/it.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import nl from './locales/nl.json';
import pl from './locales/pl.json';
import pt from './locales/pt.json';
import ru from './locales/ru.json';
import uk from './locales/uk.json';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    de: { translation: de },
    'zh-CN': { translation: zhCN },
    'zh-TW': { translation: zhTW },
    pl: { translation: pl },
    es: { translation: es },
    fr: { translation: fr },
    it: { translation: it },
    pt: { translation: pt },
    ja: { translation: ja },
    ko: { translation: ko },
    ru: { translation: ru },
    uk: { translation: uk },
    ca: { translation: ca },
    nl: { translation: nl },
    cs: { translation: cs },
  },
  lng: 'en',
  fallbackLng: 'en',
  returnEmptyString: false,
  interpolation: {
    escapeValue: false,
  },
});
