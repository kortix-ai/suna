
      const t = useTranslations('spaces');
      const say = (key) => t(key);
      const ts = useTranslations('spaces');
      successToast(say('all'));
      errorToast(ts('all'));
      successToast('Could not save your changes');
      const a = <input placeholder='{ "reasoning": "high" }' />;
      const b = <input placeholder="Describe the agent" />;
      const c = <div>No content yet.</div>;
    