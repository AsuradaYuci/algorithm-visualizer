import React from 'react';
import Cookies from 'js-cookie';
import { connect } from 'react-redux';
import Promise from 'bluebird';
import { Helmet } from 'react-helmet';
import AutosizeInput from 'react-input-autosize';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import faPlus from '@fortawesome/fontawesome-free-solid/faPlus';
import { loadProgressBar } from 'axios-progress-bar';
import 'axios-progress-bar/dist/nprogress.css';
import {
  CodeEditor,
  Header,
  Navigator,
  ResizableContainer,
  TabContainer,
  ToastContainer,
  VisualizationViewer,
} from '/components';
import { AlgorithmApi, GitHubApi } from '/apis';
import { actions } from '/reducers';
import { extension, getFiles, getTitleArray, handleError, refineGist } from '/common/util';
import { exts, languages } from '/common/config';
import { SCRATCH_PAPER_MD } from '/skeletons';
import styles from './stylesheet.scss';

loadProgressBar();

@connect(({ current, env }) => ({ current, env }), actions)
class App extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      navigatorOpened: true,
      workspaceWeights: [1, 2, 2],
      editorTabIndex: -1,
    };

    this.codeEditorRef = React.createRef();
  }

  componentDidMount() {
    window.signIn = this.signIn.bind(this);
    window.signOut = this.signOut.bind(this);

    this.loadAlgorithm(this.props.match.params);

    const accessToken = Cookies.get('access_token');
    if (accessToken) this.signIn(accessToken);

    AlgorithmApi.getCategories()
      .then(({ categories }) => this.props.setCategories(categories))
      .catch(handleError.bind(this));

    window.onbeforeunload = () => this.isGistSaved() ? undefined : 'Changes you made will not be saved.';
  }

  componentWillUnmount() {
    delete window.signIn;
    delete window.signOut;

    window.onbeforeunload = undefined;
  }

  componentWillReceiveProps(nextProps) {
    const { params } = nextProps.match;
    const { algorithm, scratchPaper } = nextProps.current;

    const categoryKey = algorithm && algorithm.categoryKey;
    const algorithmKey = algorithm && algorithm.algorithmKey;
    const gistId = scratchPaper && scratchPaper.gistId;

    if (params.categoryKey !== categoryKey ||
      params.algorithmKey !== algorithmKey ||
      params.gistId !== gistId) {
      if (nextProps.location.pathname !== this.props.location.pathname) {
        this.loadAlgorithm(params);
      } else {
        if (categoryKey && algorithmKey) {
          this.props.history.push(`/${categoryKey}/${algorithmKey}`);
        } else if (gistId) {
          this.props.history.push(`/scratch-paper/${gistId}`);
        } else {
          this.props.history.push('/');
        }
      }
    }
  }

  signIn(accessToken) {
    Cookies.set('access_token', accessToken);
    GitHubApi.auth(accessToken)
      .then(() => GitHubApi.getUser())
      .then(user => {
        const { login, avatar_url } = user;
        this.props.setUser({ login, avatar_url });
        Cookies.set('login', login);
      })
      .then(() => this.loadScratchPapers())
      .catch(() => this.signOut());
  }

  signOut() {
    Cookies.remove('access_token');
    GitHubApi.auth(undefined)
      .then(() => {
        this.props.setUser(undefined);
        Cookies.remove('login');
      })
      .then(() => this.props.setScratchPapers([]));
  }

  loadScratchPapers() {
    const per_page = 100;
    const paginateGists = (page = 1, scratchPapers = []) => GitHubApi.listGists({
      per_page,
      page,
      timestamp: Date.now(),
    }).then(gists => {
      scratchPapers.push(...gists.filter(gist => 'algorithm-visualizer' in gist.files).map(gist => ({
        key: gist.id,
        name: gist.description,
        files: Object.keys(gist.files),
      })));
      if (gists.length < per_page) {
        return scratchPapers;
      } else {
        return paginateGists(page + 1, scratchPapers);
      }
    });
    return paginateGists()
      .then(scratchPapers => this.props.setScratchPapers(scratchPapers))
      .catch(handleError.bind(this));
  }

  loadAlgorithm({ categoryKey, algorithmKey, gistId }, forceLoad = false) {
    if (!forceLoad && !this.isGistSaved() && !window.confirm('Are you sure want to discard changes?')) return;

    const { ext } = this.props.env;
    let fetchPromise = null;
    if (categoryKey && algorithmKey) {
      fetchPromise = AlgorithmApi.getAlgorithm(categoryKey, algorithmKey)
        .then(({ algorithm }) => this.props.setAlgorithm(algorithm));
    } else if (['new', 'forked'].includes(gistId)) {
      gistId = 'new';
      const language = languages.find(language => language.ext === ext);
      fetchPromise = Promise.resolve(this.props.setScratchPaper({
        gistId,
        title: 'Untitled',
        files: [{
          name: 'README.md',
          content: SCRATCH_PAPER_MD,
          contributors: undefined,
        }, {
          name: `code.${ext}`,
          content: language.skeleton,
          contributors: undefined,
        }],
      }));
    } else if (gistId) {
      fetchPromise = GitHubApi.getGist(gistId, { timestamp: Date.now() })
        .then(refineGist)
        .then(this.props.setScratchPaper);
    } else {
      fetchPromise = Promise.reject(new Error());
    }
    fetchPromise
      .catch(error => {
        if (error.message) handleError.bind(this)(error);
        this.props.setHome();
      })
      .finally(() => {
        const files = getFiles(this.props.current);
        let editorTabIndex = files.findIndex(file => extension(file.name) === ext);
        if (!~editorTabIndex) editorTabIndex = files.findIndex(file => exts.includes(extension(file.name)));
        if (!~editorTabIndex) editorTabIndex = Math.min(0, files.length - 1);
        this.handleChangeEditorTabIndex(editorTabIndex);
      });
  }

  handleChangeWorkspaceWeights(workspaceWeights) {
    this.setState({ workspaceWeights });
    this.codeEditorRef.current.getWrappedInstance().handleResize();
  }

  handleChangeEditorTabIndex(editorTabIndex) {
    const files = getFiles(this.props.current);
    if (editorTabIndex === files.length) this.handleAddFile();
    this.setState({ editorTabIndex });
    this.props.shouldBuild();
  }

  handleAddFile() {
    const { ext } = this.props.env;
    const files = getFiles(this.props.current);
    let name = `code.${ext}`;
    let count = 0;
    while (files.some(file => file.name === name)) name = `code-${++count}.${ext}`;
    const language = languages.find(language => language.ext === ext);
    this.props.addFile({
      name,
      content: language.skeleton,
      contributors: undefined,
    });
  }

  handleRenameFile(e) {
    const { value } = e.target;
    const { editorTabIndex } = this.state;
    this.props.renameFile(editorTabIndex, value);
  }

  handleDeleteFile() {
    const { editorTabIndex } = this.state;
    const files = getFiles(this.props.current);
    this.handleChangeEditorTabIndex(Math.min(editorTabIndex, files.length - 2));
    this.props.deleteFile(editorTabIndex);
  }

  toggleNavigatorOpened(navigatorOpened = !this.state.navigatorOpened) {
    this.setState({ navigatorOpened });
  }

  isGistSaved() {
    const { scratchPaper } = this.props.current;
    if (!scratchPaper) return true;
    const { title, files, lastTitle, lastFiles } = scratchPaper;
    const serializeFiles = files => JSON.stringify(files.map(({ name, content }) => ({ name, content })));
    return title === lastTitle && serializeFiles(files) === serializeFiles(lastFiles);
  }

  getDescription() {
    const files = getFiles(this.props.current);
    const readmeFile = files.find(file => file.name === 'README.md');
    if (!readmeFile) return '';
    const groups = /^\s*# .*\n+([^\n]+)/.exec(readmeFile.content);
    return groups && groups[1] || '';
  }

  render() {
    const { navigatorOpened, workspaceWeights, editorTabIndex } = this.state;

    const files = getFiles(this.props.current);
    const titleArray = getTitleArray(this.props.current);
    const gistSaved = this.isGistSaved();
    const title = `${gistSaved ? '' : '(Unsaved) '}${titleArray.join(' - ')}`;
    const description = this.getDescription();
    const file = files[editorTabIndex];

    const editorTitles = files.map(file => file.name);
    if (file) {
      editorTitles[editorTabIndex] = (
        <AutosizeInput className={styles.input_title} value={file.name}
                       onClick={e => e.stopPropagation()} onChange={e => this.handleRenameFile(e)} />
      );
    }
    editorTitles.push(
      <FontAwesomeIcon fixedWidth icon={faPlus} />,
    );

    return (
      <div className={styles.app}>
        <Helmet>
          <title>{title}</title>
          <meta name="description" content={description} />
        </Helmet>
        <Header className={styles.header} onClickTitleBar={() => this.toggleNavigatorOpened()}
                navigatorOpened={navigatorOpened} loadScratchPapers={() => this.loadScratchPapers()}
                loadAlgorithm={this.loadAlgorithm.bind(this)} gistSaved={gistSaved}
                file={file} />
        <ResizableContainer className={styles.workspace} horizontal weights={workspaceWeights}
                            visibles={[navigatorOpened, true, true]}
                            onChangeWeights={weights => this.handleChangeWorkspaceWeights(weights)}>
          <Navigator loadAlgorithm={this.loadAlgorithm.bind(this)} />
          <VisualizationViewer className={styles.visualization_viewer} />
          <TabContainer className={styles.editor_tab_container} titles={editorTitles} tabIndex={editorTabIndex}
                        onChangeTabIndex={tabIndex => this.handleChangeEditorTabIndex(tabIndex)}>
            <CodeEditor ref={this.codeEditorRef} file={file} onClickDelete={() => this.handleDeleteFile()} />
          </TabContainer>
        </ResizableContainer>
        <ToastContainer className={styles.toast_container} />
      </div>
    );
  }
}

export default App;
