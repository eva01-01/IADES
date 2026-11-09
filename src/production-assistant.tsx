import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Eye, LoaderCircle, Sparkles, X } from 'lucide-react';
import { createProject, deleteProject, getLocalAISettings, requestAIImage, requestAIText, requestLocalPosterImage, requestLocalPosterPlan, requestLocalProductPlan, saveProject, storeAsset } from './api';
import type { LocalAIStatus } from './api';
import type { ProductTemplate } from './product-templates';
import { applyProductTemplate, getProductTemplate } from './product-templates';
import { adaptProjectToTemplate, createPosterDraft, parsePosterBrief, parseProductDesignPlan, type ProductDesignConcept } from './production-automation';
import { prepareGeneratedImage } from './auto-cutout';
import type { DesignProject } from './types';
import { createId } from './id';

export type ProductionMode = 'poster' | 'adapt' | 'prepare' | 'product';
export type ProductionAssistantResult = { project: DesignProject; createdProjects: DesignProject[]; warnings?: string[] };
type GeneratedProductDesign = { project: DesignProject; concept: ProductDesignConcept; templates: ProductTemplate[]; warnings: string[] };

async function readAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read the image asset.'));
    reader.readAsDataURL(blob);
  });
}

async function cloneLocalAssets(project: DesignProject, projectId: string): Promise<DesignProject> {
  const remapped = new Map<string, string>();
  for (const node of project.nodes) {
    for (const source of [node.src, node.originalSrc, node.maskSrc]) {
      if (!source || remapped.has(source) || !/^\/api\/assets\/[0-9a-f-]{36}$/i.test(source)) continue;
      const response = await fetch(source);
      if (!response.ok) throw new Error(`Unable to copy a linked project image (${response.status}).`);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      const asset = await storeAsset({ projectId, name: node.sourceName ?? node.name, dataUrl: await readAsDataUrl(blob), width: bitmap.width, height: bitmap.height, sourceName: node.sourceName });
      bitmap.close();
      remapped.set(source, asset.src);
    }
  }
  return {
    ...project,
    nodes: project.nodes.map((node) => ({
      ...node,
      src: node.src ? remapped.get(node.src) ?? node.src : undefined,
      originalSrc: node.originalSrc ? remapped.get(node.originalSrc) ?? node.originalSrc : undefined,
      maskSrc: node.maskSrc ? remapped.get(node.maskSrc) ?? node.maskSrc : undefined,
    })),
  };
}

export function ProductionAssistant({ project, templates, lang, onClose, onPrepare, onComplete, onPreview, aiConfigured, aiMode, onConfigureAI }: {
  project: DesignProject;
  templates: ProductTemplate[];
  lang: 'fr' | 'en';
  onClose: () => void;
  onPrepare: (imageIds: string[], model: 'universal' | 'portrait', onProgress: (message: string) => void) => Promise<DesignProject>;
  onComplete: (result: ProductionAssistantResult) => void;
  onPreview: (project: DesignProject, template: ProductTemplate) => void;
  aiConfigured: boolean;
  aiMode: 'local' | 'provider';
  onConfigureAI: () => void;
}) {
  const french = lang === 'fr';
  const [mode, setMode] = useState<ProductionMode>('poster');
  const [prompt, setPrompt] = useState('');
  const [selectedTemplates, setSelectedTemplates] = useState<string[]>(() => [project.productTemplateId ?? 'poster']);
  const [selectedImages, setSelectedImages] = useState<string[]>(() => project.nodes.filter((node) => node.type === 'image' && node.src).map((node) => node.id));
  const [model, setModel] = useState<'universal' | 'portrait'>('universal');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [localStatus, setLocalStatus] = useState<LocalAIStatus | null>(null);
  const [productDesigns, setProductDesigns] = useState<GeneratedProductDesign[]>([]);
  const [productCreated, setProductCreated] = useState<DesignProject[]>([]);
  const imageNodes = project.nodes.filter((node) => node.type === 'image' && node.src);
  const availableTemplates = templates.length ? templates : [getProductTemplate('poster')];
  const localPosterReady = !!localStatus?.selectedTextModelAvailable && !!localStatus.selectedCheckpointAvailable;

  useEffect(() => {
    if (aiMode !== 'local') return;
    void getLocalAISettings().then((settings) => setLocalStatus(settings.status ?? null)).catch(() => setLocalStatus(null));
  }, [aiMode]);
  const toggleTemplate = (id: string) => setSelectedTemplates((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleImage = (id: string) => setSelectedImages((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const discardProductResults = async () => {
    const created = productCreated;
    setProductCreated([]);
    setProductDesigns([]);
    await Promise.all(created.map((item) => deleteProject(item.id, project.id).catch(() => undefined)));
  };
  const closeAssistant = async () => {
    if (productCreated.length) await discardProductResults();
    onClose();
  };
  const openProductDesign = (design: GeneratedProductDesign) => {
    onComplete({ project: design.project, createdProjects: productCreated, warnings: design.warnings });
    setProductCreated([]);
    setProductDesigns([]);
  };

  const run = async () => {
    setBusy(true);
    setError('');
    const created: DesignProject[] = [];
    try {
      if (mode === 'prepare') {
        if (!selectedImages.length) throw new Error(french ? 'Sélectionnez au moins une image.' : 'Select at least one image.');
        setProgress(french ? 'Détourage local des images sélectionnées…' : 'Locally removing backgrounds from selected images…');
        const preparedProject = await onPrepare(selectedImages, model, setProgress);
        onComplete({ project: preparedProject, createdProjects: [] });
        setProgress(french ? 'Images préparées.' : 'Images prepared.');
        return;
      }
      if (mode === 'product') {
        if (aiMode !== 'local') throw new Error(french ? 'Cette recherche utilise uniquement Ollama et ComfyUI locaux. Passez en mode local dans les réglages IA.' : 'This search uses only local Ollama and ComfyUI. Switch to local mode in AI settings.');
        if (!localPosterReady) throw new Error(french ? 'Ollama, son modèle de texte, ComfyUI et un checkpoint image doivent être actifs dans les réglages IA.' : 'Ollama, its text model, ComfyUI, and an image checkpoint must be available in AI settings.');
        if (!prompt.trim()) throw new Error(french ? 'Décrivez le produit et le style recherché.' : 'Describe the product and style you want.');
        setProgress(french ? 'Analyse de la demande et création de trois concepts…' : 'Analyzing the brief and creating three concepts…');
        const plan = parseProductDesignPlan((await requestLocalProductPlan(prompt.trim())).text);
        const designs: GeneratedProductDesign[] = [];
        const warnings: string[] = [];
        for (let index = 0; index < plan.length; index += 1) {
          const concept = plan[index];
          const selectedProductTemplates = concept.productIds.map((id) => availableTemplates.find((template) => template.id === id) ?? getProductTemplate(id));
          const primaryTemplate = selectedProductTemplates[0] ?? getProductTemplate('poster');
          let shell: DesignProject | undefined;
          try {
            setProgress(french ? `Concept ${index + 1}/${plan.length} : création du visuel…` : `Concept ${index + 1}/${plan.length}: generating artwork…`);
            const posterBase = applyProductTemplate({ ...project, id: createId(), nodes: [] }, getProductTemplate('poster'));
            const posterDraft = createPosterDraft(posterBase, concept, () => createId(), project.id);
            const id = createId();
            const candidate = primaryTemplate.id === 'poster' ? { ...posterDraft, id, automationParentId: project.id } : { ...adaptProjectToTemplate(posterDraft, primaryTemplate, id, () => createId()), automationParentId: project.id };
            shell = await createProject(candidate);
            created.push(shell);
            setProductCreated([...created]);
            const image = await requestLocalPosterImage({ projectId: shell.id, prompt: concept.imagePrompt, allowBrandLogo: true });
            setProgress(french ? `Concept ${index + 1}/${plan.length} : détourage local…` : `Concept ${index + 1}/${plan.length}: removing the background locally…`);
            const prepared = await prepareGeneratedImage(shell.id, image);
            const completed = await saveProject({
              ...shell,
              nodes: shell.nodes.map((node) => node.name === 'Generated artwork' ? { ...node, src: prepared.src, originalSrc: prepared.originalSrc, maskSrc: prepared.maskSrc, sourceWidth: prepared.width, sourceHeight: prepared.height, sourceName: prepared.sourceName } : node),
            });
            created[created.length - 1] = completed;
            setProductCreated([...created]);
            const conceptWarnings = prepared.cutoutWarning ? [french ? `Détourage non effectué : ${prepared.cutoutWarning}` : `Background removal failed: ${prepared.cutoutWarning}`] : [];
            warnings.push(...conceptWarnings.map((warning) => `${concept.title}: ${warning}`));
            designs.push({ project: completed, concept, templates: selectedProductTemplates, warnings: conceptWarnings });
            setProductDesigns([...designs]);
          } catch (reason) {
            if (shell) {
              await deleteProject(shell.id, project.id).catch(() => undefined);
              const indexToRemove = created.findIndex((item) => item.id === shell!.id);
              if (indexToRemove >= 0) created.splice(indexToRemove, 1);
              setProductCreated([...created]);
            }
            warnings.push(`${concept.title}: ${reason instanceof Error ? reason.message : (french ? 'génération impossible' : 'generation failed')}`);
          }
        }
        if (!designs.length) throw new Error(warnings.join('\n') || (french ? 'Aucun concept n’a pu être généré.' : 'No design concept could be generated.'));
        setProductDesigns(designs);
        setProductCreated(created);
        setProgress(french ? `${designs.length} concept(s) prêt(s).` : `${designs.length} concept(s) ready.`);
        if (warnings.length) setError(warnings.join('\n'));
        return;
      }
      const selectedTargetTemplates = availableTemplates.filter((template) => selectedTemplates.includes(template.id));
      const targetTemplates = mode === 'poster' ? [getProductTemplate('poster'), ...selectedTargetTemplates.filter((template) => template.id !== 'poster')] : selectedTargetTemplates;
      if (!targetTemplates.length) throw new Error(french ? 'Choisissez au moins un produit ou format.' : 'Choose at least one product or format.');
      let sourceForTargets = project;
      if (mode === 'poster') {
        if (!prompt.trim()) throw new Error(french ? 'Décrivez l’affiche souhaitée.' : 'Describe the poster you want.');
        setProgress(french ? 'Création du brief et des textes…' : 'Creating the brief and poster copy…');
        const planResponse = aiMode === 'local' ? await requestLocalPosterPlan(prompt.trim()) : await requestAIText('poster-plan', prompt.trim());
        const brief = parsePosterBrief(planResponse.text);
        const posterTemplate = getProductTemplate('poster');
        const posterBase = applyProductTemplate({ ...project, id: createId(), nodes: [] }, posterTemplate);
        const draft = createPosterDraft(posterBase, brief, () => createId(), project.id);
        setProgress(french ? 'Préparation de l’illustration…' : 'Generating the poster artwork…');
        const createdBase = await createProject(draft);
        created.push(createdBase);
        const image = aiMode === 'local' ? await requestLocalPosterImage({ projectId: createdBase.id, prompt: brief.imagePrompt }) : await requestAIImage({ projectId: createdBase.id, task: 'generate', prompt: brief.imagePrompt });
        const completedDraft = await saveProject({
          ...createdBase,
          nodes: createdBase.nodes.map((node) => node.name === 'Generated artwork' ? { ...node, src: image.src, sourceWidth: image.width, sourceHeight: image.height, sourceName: image.sourceName } : node),
        });
        created[0] = completedDraft;
        sourceForTargets = completedDraft;
      }
      const outputs: DesignProject[] = [];
      const warnings: string[] = [];
      for (const template of targetTemplates) {
        setProgress(french ? `Adaptation : ${template.name}…` : `Adapting to ${template.name}…`);
        if (mode === 'poster' && template.id === 'poster') {
          outputs.push(sourceForTargets);
          continue;
        }
        let shell: DesignProject | undefined;
        try {
          const id = createId();
          let candidate: DesignProject = adaptProjectToTemplate(sourceForTargets, template, id, () => createId());
          shell = await createProject(candidate);
          created.push(shell);
          candidate = await cloneLocalAssets(candidate, shell.id);
          const saved = await saveProject({ ...candidate, id: shell.id });
          created[created.length - 1] = saved;
          outputs.push(saved);
        } catch (reason) {
          if (shell) {
            await deleteProject(shell.id, project.id).catch(() => undefined);
            const createdIndex = created.findIndex((item) => item.id === shell!.id);
            if (createdIndex >= 0) created.splice(createdIndex, 1);
          }
          const message = reason instanceof Error ? reason.message : 'The format could not be adapted.';
          warnings.push(`${template.name}: ${message}`);
        }
      }
      const selected = outputs[0];
      if (!selected) throw new Error(french ? 'Aucune déclinaison valide n’a été créée.' : 'No valid format variant was created.');
      onComplete({ project: selected, createdProjects: created, warnings });
      setProgress(french ? `${outputs.length} projet(s) éditable(s) prêt(s).` : `${outputs.length} editable project(s) ready.`);
    } catch (reason) {
      await Promise.all(created.map((item) => deleteProject(item.id, project.id).catch(() => undefined)));
      setError(reason instanceof Error ? reason.message : (french ? 'L’automatisation a échoué.' : 'Automation failed.'));
      setProgress('');
    } finally {
      setBusy(false);
    }
  };

  const productGallery = productDesigns.length ? <section className="product-design-gallery" aria-label={french ? 'Concepts générés' : 'Generated concepts'}><div className="product-design-gallery-head"><div><strong>{french ? 'Vos propositions' : 'Your concepts'}</strong><span>{french ? 'Choisissez un visuel pour l’ouvrir et le modifier.' : 'Choose a concept to open and edit.'}</span></div><button disabled={busy} onClick={() => void discardProductResults()}>{french ? 'Nouvelle recherche' : 'New search'}</button></div><div className="product-design-cards">{productDesigns.map((design) => {
    const artwork = design.project.nodes.find((node) => node.type === 'image' && node.name === 'Generated artwork');
    return <article className="product-design-card" key={design.project.id}><div className="product-design-art" style={{ background: design.concept.backgroundColor }}>{artwork?.src && <img src={artwork.src} alt={design.concept.title}/>}</div><div className="product-design-card-copy"><h3>{design.concept.title}</h3><p>{design.concept.subtitle || design.concept.body}</p><small>{french ? 'Marque et typographie générées par IA à vérifier.' : 'AI-generated brand marks and text should be checked.'}</small>{design.warnings.map((warning) => <small className="product-design-warning" key={warning}>{warning}</small>)}<div className="product-design-actions"><button disabled={busy} onClick={() => openProductDesign(design)}>{french ? 'Ouvrir et modifier' : 'Open and edit'}</button></div><div className="product-design-preview-list">{design.templates.map((template) => <button key={template.id} disabled={busy} onClick={() => onPreview(design.project, template)}><Eye size={13}/>{french ? 'Voir' : 'Preview'} · {template.name}</button>)}</div></div></article>;
  })}</div></section> : null;

  return <div className="modal-backdrop" data-testid="production-assistant" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) void closeAssistant(); }}><section className="production-modal"><header><div><span><Sparkles size={14}/>{french ? 'ASSISTANT DE PRODUCTION IA' : 'AI PRODUCTION ASSISTANT'}</span><h2>{french ? 'Automatiser la production' : 'Automate production'}</h2></div><button aria-label={french ? 'Fermer' : 'Close'} disabled={busy} onClick={() => void closeAssistant()}><X size={17}/></button></header><div className="production-modes"><button className={mode === 'poster' ? 'active' : ''} onClick={() => setMode('poster')}>{french ? 'Créer une affiche' : 'Create a poster'}</button><button className={mode === 'adapt' ? 'active' : ''} onClick={() => setMode('adapt')}>{french ? 'Décliner les formats' : 'Adapt formats'}</button><button className={mode === 'prepare' ? 'active' : ''} onClick={() => setMode('prepare')}>{french ? 'Préparer les images' : 'Prepare images'}</button><button className={mode === 'product' ? 'active' : ''} onClick={() => setMode('product')}>{french ? 'Nouveau design produit' : 'Product design'}</button></div>{mode === 'poster' && (aiMode === 'provider' ? !aiConfigured : !localPosterReady) && <div className="production-message error production-ai-warning" role="alert"><AlertTriangle size={14}/><span>{aiMode === 'local' ? (french ? 'Démarrez Ollama et ComfyUI, installez les modèles locaux et vérifiez leur disponibilité dans les réglages IA.' : 'Start Ollama and ComfyUI, install the local models, and check their status in AI settings.') : (french ? 'Ajoutez une clé API de fournisseur IA pour créer une affiche.' : 'Add an AI provider API key to create a poster.')}</span><button onClick={onConfigureAI}>{french ? 'Réglages IA' : 'AI settings'}</button></div>}{mode === 'product' && (aiMode !== 'local' || !localPosterReady) && <div className="production-message error production-ai-warning" role="alert"><AlertTriangle size={14}/><span>{french ? 'Pour conserver les données sur cet appareil, sélectionnez le mode local et démarrez Ollama + ComfyUI avec les modèles requis.' : 'To keep data on this device, select local mode and start Ollama + ComfyUI with the required models.'}</span><button onClick={onConfigureAI}>{french ? 'Réglages IA' : 'AI settings'}</button></div>}<div className="production-content">{(mode === 'poster' || mode === 'adapt' || mode === 'product') && <><label className="production-label">{french ? 'Votre consigne' : 'Your brief'}{(mode === 'poster' || mode === 'product') && <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={mode === 'product' ? (french ? 'Ex. Étiquette Yomil pour pot et bouteille de yaourt, couleurs jaune et bleu…' : 'E.g. Yomil yogurt cup and bottle label, yellow and blue palette…') : (french ? 'Ex. Affiche de concert jazz, élégante, couleurs chaudes…' : 'E.g. elegant jazz concert poster in warm colors…')}/>}</label>{(mode === 'poster' || mode === 'adapt') && <><div className="production-template-title">{mode === 'poster' ? (french ? 'Créer une copie dans les formats' : 'Create a copy in these formats') : (french ? 'Formats à créer à partir du projet courant' : 'Formats to create from the current project')}</div><div className="production-template-list">{availableTemplates.map((template) => <label key={template.id}><input type="checkbox" checked={selectedTemplates.includes(template.id)} onChange={() => toggleTemplate(template.id)}/><span>{template.name}</span><small>{template.widthMm} × {template.heightMm} mm</small></label>)}</div></>}</>}{mode === 'prepare' && <><p>{french ? 'Les fonds sont supprimés localement. Les originaux et masques restent modifiables.' : 'Backgrounds are removed locally. Originals and editable masks are preserved.'}</p><label className="production-label">{french ? 'Modèle de détourage' : 'Background removal model'}<select value={model} onChange={(event) => setModel(event.target.value as typeof model)}><option value="universal">BiRefNet Lite · {french ? 'objets généraux' : 'general objects'}</option><option value="portrait">MODNet · {french ? 'portraits' : 'portraits'}</option></select></label><div className="production-template-title">{french ? 'Images du projet' : 'Project images'}</div><div className="production-template-list">{imageNodes.map((node) => <label key={node.id}><input type="checkbox" checked={selectedImages.includes(node.id)} onChange={() => toggleImage(node.id)}/><span>{node.name}</span></label>)}</div>{!imageNodes.length && <p>{french ? 'Ce projet ne contient aucune image.' : 'This project has no images.'}</p>}</>}{mode === 'product' && productGallery}{error && <div className="production-message error"><AlertTriangle size={14}/>{error}</div>}{progress && <div className="production-message" role="status">{busy ? <LoaderCircle className="production-spinner" size={14}/> : <Check size={14}/>}<span>{progress}</span></div>}<div className="production-privacy"><AlertTriangle size={13}/><span>{mode === 'prepare' ? (french ? 'Détourage et mise en page exécutés localement. Une étape en cours n’est pas annulable ; les modifications appliquées restent réversibles.' : 'Background removal and layout run locally. An in-progress run cannot be cancelled; applied changes remain reversible.') : mode === 'adapt' ? (french ? 'Les déclinaisons et contrôles de mise en page sont exécutés localement. Le projet source reste intact.' : 'Format adaptation and layout checks run locally. The source project stays unchanged.') : aiMode === 'local' ? (french ? 'Brief et illustration générés sur ce PC via Ollama et ComfyUI. Aucun prompt ou image n’est envoyé à un fournisseur distant.' : 'Brief and artwork are generated on this PC through Ollama and ComfyUI. No prompts or images are sent to a remote provider.') : (french ? 'Prompts et images envoyés au fournisseur IA configuré. L’original est conservé ; les nouveaux projets peuvent être annulés.' : 'Prompts and images are sent to the configured AI provider. The original is preserved; generated projects can be undone.')}</span></div></div><footer><button disabled={busy} onClick={() => void closeAssistant()}>{french ? 'Fermer' : 'Close'}</button><button className="assistant-generate" data-testid="run-production-automation" disabled={busy || (mode === 'poster' && (!prompt.trim() || (aiMode === 'provider' ? !aiConfigured : !localPosterReady))) || (mode === 'product' && (!prompt.trim() || aiMode !== 'local' || !localPosterReady || productDesigns.length > 0)) || (mode === 'prepare' && (!selectedImages.length || !imageNodes.length))} onClick={() => void run()}><Sparkles size={14}/>{busy ? (french ? 'En cours…' : 'Running…') : mode === 'prepare' ? (french ? 'Préparer' : 'Prepare images') : mode === 'adapt' ? (french ? 'Créer les déclinaisons' : 'Create variants') : (french ? 'Créer l’affiche' : 'Create poster')}</button></footer></section></div>;
}
