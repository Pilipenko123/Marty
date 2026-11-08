(() => {
  'use strict';

  const CHAT_URL = 'https://segachat.pilpro.ru/';
  const menuButton = document.querySelector('.menu-toggle');
  const mobileMenu = document.querySelector('#mobile-menu');

  if (menuButton && mobileMenu) {
    const closeMenu = () => {
      menuButton.setAttribute('aria-expanded', 'false');
      menuButton.setAttribute('aria-label', 'Открыть меню');
      mobileMenu.hidden = true;
    };

    menuButton.addEventListener('click', () => {
      const isOpen = menuButton.getAttribute('aria-expanded') === 'true';
      menuButton.setAttribute('aria-expanded', String(!isOpen));
      menuButton.setAttribute('aria-label', isOpen ? 'Открыть меню' : 'Закрыть меню');
      mobileMenu.hidden = isOpen;
    });

    mobileMenu.addEventListener('click', (event) => {
      if (event.target.closest('a')) closeMenu();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !mobileMenu.hidden) {
        closeMenu();
        menuButton.focus();
      }
    });
  }

  const serviceSelect = document.querySelector('select[name="service"]');
  const taskField = document.querySelector('textarea[name="message"]');
  document.querySelectorAll('[data-prefill="portfolio"]').forEach((link) => {
    link.addEventListener('click', () => {
      if (serviceSelect) serviceSelect.value = 'Запрос портфолио';
      if (taskField && !taskField.value.trim()) taskField.value = 'Пожалуйста, пришлите примеры работ по нашей задаче.';
    });
  });

  const form = document.querySelector('#request-form');
  const result = document.querySelector('#request-result');
  const resultCopy = document.querySelector('#result-copy');
  const preparedMessage = document.querySelector('#prepared-message');
  const copyAgain = document.querySelector('#copy-again');

  const copyToClipboard = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    if (!preparedMessage) return false;
    preparedMessage.focus();
    preparedMessage.select();
    try {
      return document.execCommand('copy');
    } catch (_) {
      return false;
    }
  };

  const composeRequest = (data) => {
    const lines = [
      'Заявка с сайта PILPRO.ru',
      '',
      `Имя: ${data.get('name').trim()}`,
      `Контакт для ответа: ${data.get('contact').trim()}`
    ];
    const service = String(data.get('service') || '').trim();
    const message = String(data.get('message') || '').trim();
    if (service) lines.push(`Направление: ${service}`);
    if (message) lines.push('', 'Задача:', message);
    return lines.join('\n');
  };

  if (form && result && preparedMessage) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;

      const text = composeRequest(new FormData(form));
      preparedMessage.value = text;
      result.hidden = false;
      resultCopy.textContent = 'Открываем Segachat. Скопируйте текст, вставьте его в чат и отправьте команде.';

      // Open immediately during the user's click so the browser does not block the tab.
      window.open(CHAT_URL, '_blank', 'noopener,noreferrer');

      let copied = false;
      try {
        copied = await copyToClipboard(text);
      } catch (_) {
        copied = false;
      }

      resultCopy.textContent = copied
        ? 'Текст заявки скопирован. Вставьте его в открывшийся Segachat и нажмите «Отправить».'
        : 'Не удалось скопировать автоматически. Скопируйте текст из поля ниже и вставьте его в Segachat.';

      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (!copied) preparedMessage.focus();
    });
  }

  if (copyAgain && preparedMessage && resultCopy) {
    copyAgain.addEventListener('click', async () => {
      let copied = false;
      try {
        copied = await copyToClipboard(preparedMessage.value);
      } catch (_) {
        copied = false;
      }
      resultCopy.textContent = copied
        ? 'Текст заявки скопирован. Вставьте его в Segachat и нажмите «Отправить».'
        : 'Выделите текст в поле выше, скопируйте и вставьте его в Segachat.';
    });
  }

  const year = document.querySelector('#current-year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
